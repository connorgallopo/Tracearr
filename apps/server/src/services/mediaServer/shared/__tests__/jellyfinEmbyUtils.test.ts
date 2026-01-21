/**
 * Unit tests for Jellyfin/Emby shared utilities
 *
 * Tests shared utility functions used for parsing Jellyfin/Emby responses,
 * including live TV metadata, music metadata, progress calculation,
 * and content filtering.
 */

import { describe, it, expect } from 'vitest';
import {
  extractLiveTvMetadata,
  extractMusicMetadata,
  shouldFilterItem,
  extractStreamDetails,
  getBitrate,
} from '../jellyfinEmbyUtils.js';
import { calculateProgress } from '../parserUtils.js';

// ============================================================================
// Test Fixtures for Stream Details
// ============================================================================

/** Creates a mock Jellyfin/Emby session with stream data */
function createMockSession(
  overrides: {
    videoStream?: Record<string, unknown>;
    audioStream?: Record<string, unknown>;
    subtitleStream?: Record<string, unknown>;
    transcodingInfo?: Record<string, unknown>;
    container?: string;
  } = {}
) {
  const mediaStreams: Record<string, unknown>[] = [];

  if (overrides.videoStream !== null) {
    mediaStreams.push({
      Type: 'Video',
      Codec: 'hevc',
      Width: 3840,
      Height: 2160,
      BitRate: 40000000, // 40 Mbps
      RealFrameRate: 23.976,
      Profile: 'Main 10',
      Level: 5.1,
      VideoRangeType: 'HDR10',
      ColorSpace: 'bt2020nc',
      ColorTransfer: 'smpte2084',
      BitDepth: 10,
      IsDefault: true,
      ...overrides.videoStream,
    });
  }

  if (overrides.audioStream !== null) {
    mediaStreams.push({
      Type: 'Audio',
      Codec: 'truehd',
      Channels: 8,
      ChannelLayout: '7.1',
      Language: 'eng',
      SampleRate: 48000,
      BitRate: 5000000, // 5 Mbps
      IsDefault: true,
      ...overrides.audioStream,
    });
  }

  if (overrides.subtitleStream) {
    mediaStreams.push({
      Type: 'Subtitle',
      Codec: 'srt',
      Language: 'eng',
      IsForced: false,
      IsDefault: true,
      ...overrides.subtitleStream,
    });
  }

  return {
    NowPlayingItem: {
      MediaSources: [
        {
          Container: overrides.container ?? 'mkv',
          Bitrate: 45000000,
          MediaStreams: mediaStreams,
        },
      ],
    },
    TranscodingInfo: overrides.transcodingInfo,
  };
}

describe('extractLiveTvMetadata', () => {
  it('returns undefined when no channel title available', () => {
    expect(extractLiveTvMetadata({})).toBeUndefined();
    expect(extractLiveTvMetadata({ ChannelId: '123' })).toBeUndefined();
  });

  it('extracts channel title from ChannelName', () => {
    const result = extractLiveTvMetadata({
      ChannelName: 'CNN',
      ChannelId: 'channel-123',
    });
    expect(result).toEqual({
      channelTitle: 'CNN',
      channelIdentifier: undefined,
      channelThumb: '/Items/channel-123/Images/Primary',
    });
  });

  it('falls back to Name when ChannelName not present', () => {
    const result = extractLiveTvMetadata({
      Name: 'BBC News',
      ChannelId: 'bbc-123',
    });
    expect(result).toEqual({
      channelTitle: 'BBC News',
      channelIdentifier: undefined,
      channelThumb: '/Items/bbc-123/Images/Primary',
    });
  });

  it('prefers ChannelName over Name', () => {
    const result = extractLiveTvMetadata({
      ChannelName: 'Channel Title',
      Name: 'Program Name',
      ChannelId: 'ch-123',
    });
    expect(result?.channelTitle).toBe('Channel Title');
  });

  it('extracts channel number as identifier', () => {
    const result = extractLiveTvMetadata({
      ChannelName: 'ESPN',
      ChannelNumber: '42',
      ChannelId: 'espn-123',
    });
    expect(result?.channelIdentifier).toBe('42');
  });

  it('truncates channel title to 255 characters', () => {
    const longTitle = 'A'.repeat(300);
    const result = extractLiveTvMetadata({
      ChannelName: longTitle,
    });
    expect(result?.channelTitle).toHaveLength(255);
  });

  it('truncates channel identifier to 100 characters', () => {
    const longNumber = '1'.repeat(150);
    const result = extractLiveTvMetadata({
      ChannelName: 'Test',
      ChannelNumber: longNumber,
    });
    expect(result?.channelIdentifier).toHaveLength(100);
  });

  it('returns undefined channelThumb when no ChannelId', () => {
    const result = extractLiveTvMetadata({
      ChannelName: 'Test Channel',
    });
    expect(result?.channelThumb).toBeUndefined();
  });
});

describe('extractMusicMetadata', () => {
  it('returns undefined artistName when no artist info available', () => {
    const result = extractMusicMetadata({});
    expect(result).toEqual({
      artistName: undefined,
      albumName: undefined,
      trackNumber: undefined,
      discNumber: undefined,
    });
  });

  it('extracts AlbumArtist as primary artist', () => {
    const result = extractMusicMetadata({
      AlbumArtist: 'The Beatles',
      Artists: ['John Lennon'],
    });
    expect(result.artistName).toBe('The Beatles');
  });

  it('falls back to Artists array when no AlbumArtist', () => {
    const result = extractMusicMetadata({
      Artists: ['Paul McCartney', 'Wings'],
    });
    expect(result.artistName).toBe('Paul McCartney');
  });

  it('extracts album name', () => {
    const result = extractMusicMetadata({
      AlbumArtist: 'Artist',
      Album: 'Abbey Road',
    });
    expect(result.albumName).toBe('Abbey Road');
  });

  it('extracts track and disc numbers', () => {
    const result = extractMusicMetadata({
      AlbumArtist: 'Artist',
      IndexNumber: 5,
      ParentIndexNumber: 2,
    });
    expect(result.trackNumber).toBe(5);
    expect(result.discNumber).toBe(2);
  });

  it('truncates artist name to 255 characters', () => {
    const longName = 'B'.repeat(300);
    const result = extractMusicMetadata({
      AlbumArtist: longName,
    });
    expect(result.artistName).toHaveLength(255);
  });

  it('truncates album name to 255 characters', () => {
    const longAlbum = 'C'.repeat(300);
    const result = extractMusicMetadata({
      AlbumArtist: 'Artist',
      Album: longAlbum,
    });
    expect(result.albumName).toHaveLength(255);
  });

  it('handles Artists array truncation', () => {
    const longArtist = 'D'.repeat(300);
    const result = extractMusicMetadata({
      Artists: [longArtist],
    });
    expect(result.artistName).toHaveLength(255);
  });

  it('handles null/undefined track numbers', () => {
    const result = extractMusicMetadata({
      AlbumArtist: 'Artist',
      IndexNumber: null,
      ParentIndexNumber: undefined,
    });
    expect(result.trackNumber).toBeUndefined();
    expect(result.discNumber).toBeUndefined();
  });
});

describe('calculateProgress', () => {
  it('returns 0 when duration is 0', () => {
    expect(calculateProgress(1000, 0)).toBe(0);
  });

  it('returns 0 when duration is negative', () => {
    expect(calculateProgress(1000, -100)).toBe(0);
  });

  it('returns 0 when position is 0', () => {
    expect(calculateProgress(0, 10000)).toBe(0);
  });

  it('calculates correct percentage', () => {
    expect(calculateProgress(5000, 10000)).toBe(50);
    expect(calculateProgress(7500, 10000)).toBe(75);
    expect(calculateProgress(2500, 10000)).toBe(25);
  });

  it('rounds to nearest integer', () => {
    // 3333 / 10000 = 0.3333 -> 33%
    expect(calculateProgress(3333, 10000)).toBe(33);
    // 6666 / 10000 = 0.6666 -> 67%
    expect(calculateProgress(6666, 10000)).toBe(67);
  });

  it('caps progress at 100%', () => {
    expect(calculateProgress(15000, 10000)).toBe(100);
    expect(calculateProgress(10001, 10000)).toBe(100);
  });

  it('handles edge case of position equal to duration', () => {
    expect(calculateProgress(10000, 10000)).toBe(100);
  });

  it('handles very small progress', () => {
    // 1 / 10000 = 0.0001 -> rounds to 0%
    expect(calculateProgress(1, 10000)).toBe(0);
    // 50 / 10000 = 0.005 -> rounds to 1%
    expect(calculateProgress(50, 10000)).toBe(1);
  });
});

describe('shouldFilterItem', () => {
  it('filters trailer items', () => {
    expect(shouldFilterItem({ Type: 'Trailer' })).toBe(true);
    expect(shouldFilterItem({ Type: 'trailer' })).toBe(true);
    expect(shouldFilterItem({ Type: 'TRAILER' })).toBe(true);
  });

  it('filters theme songs', () => {
    expect(shouldFilterItem({ Type: 'Audio', ExtraType: 'ThemeSong' })).toBe(true);
    expect(shouldFilterItem({ Type: 'Audio', ExtraType: 'themesong' })).toBe(true);
  });

  it('filters theme videos', () => {
    expect(shouldFilterItem({ Type: 'Video', ExtraType: 'ThemeVideo' })).toBe(true);
    expect(shouldFilterItem({ Type: 'Video', ExtraType: 'themevideo' })).toBe(true);
  });

  it('filters preroll videos by provider ID', () => {
    expect(
      shouldFilterItem({
        Type: 'Video',
        ProviderIds: { 'prerolls.video': 'some-id' },
      })
    ).toBe(true);
  });

  it('does not filter regular movies', () => {
    expect(shouldFilterItem({ Type: 'Movie', Name: 'Some Movie' })).toBe(false);
  });

  it('does not filter regular episodes', () => {
    expect(shouldFilterItem({ Type: 'Episode', Name: 'Some Episode' })).toBe(false);
  });

  it('does not filter regular music tracks', () => {
    expect(shouldFilterItem({ Type: 'Audio', Name: 'Some Song' })).toBe(false);
    expect(shouldFilterItem({ Type: 'MusicTrack', Name: 'Some Song' })).toBe(false);
  });

  it('does not filter live TV channels', () => {
    expect(shouldFilterItem({ Type: 'TvChannel', Name: 'CNN' })).toBe(false);
    expect(shouldFilterItem({ Type: 'LiveTvChannel', Name: 'ESPN' })).toBe(false);
  });

  it('handles empty objects', () => {
    expect(shouldFilterItem({})).toBe(false);
  });

  it('handles videos without preroll provider IDs', () => {
    expect(
      shouldFilterItem({
        Type: 'Video',
        ProviderIds: { tmdb: '12345', imdb: 'tt12345' },
      })
    ).toBe(false);
  });
});

// ============================================================================
// Stream Detail Extraction Tests
// ============================================================================

describe('extractStreamDetails', () => {
  describe('source video details', () => {
    it('extracts video codec in uppercase', () => {
      const session = createMockSession({ videoStream: { Codec: 'hevc' } });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoCodec).toBe('HEVC');
    });

    it('extracts video resolution', () => {
      const session = createMockSession({
        videoStream: { Width: 3840, Height: 2160 },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.bitrate).toBeDefined();
    });

    it('extracts video bitrate in kbps', () => {
      const session = createMockSession({
        videoStream: { BitRate: 40000000 }, // 40 Mbps in bps
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.bitrate).toBe(40000); // 40000 kbps
    });

    it('extracts framerate from RealFrameRate', () => {
      const session = createMockSession({
        videoStream: { RealFrameRate: 23.976 },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.framerate).toBe('23.976');
    });

    it('falls back to AverageFrameRate when RealFrameRate unavailable', () => {
      const session = createMockSession({
        videoStream: { RealFrameRate: undefined, AverageFrameRate: 24 },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.framerate).toBe('24');
    });

    it('extracts profile and level', () => {
      const session = createMockSession({
        videoStream: { Profile: 'Main 10', Level: 5.1 },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.profile).toBe('Main 10');
      expect(result.sourceVideoDetails?.level).toBe('5.1');
    });

    it('extracts color space and depth', () => {
      const session = createMockSession({
        videoStream: { ColorSpace: 'bt2020nc', BitDepth: 10 },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.colorSpace).toBe('bt2020nc');
      expect(result.sourceVideoDetails?.colorDepth).toBe(10);
    });
  });

  describe('dynamic range detection', () => {
    it('detects HDR10 from VideoRangeType', () => {
      const session = createMockSession({
        videoStream: { VideoRangeType: 'HDR10' },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('HDR10');
    });

    it('detects HDR10+ from VideoRangeType', () => {
      const session = createMockSession({
        videoStream: { VideoRangeType: 'HDR10Plus' },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('HDR10+');
    });

    it('detects HLG from VideoRangeType', () => {
      const session = createMockSession({
        videoStream: { VideoRangeType: 'HLG' },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('HLG');
    });

    it('detects Dolby Vision from VideoRangeType', () => {
      const session = createMockSession({
        videoStream: { VideoRangeType: 'DOVi' },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('Dolby Vision');
    });

    it('detects Dolby Vision with HDR10 fallback', () => {
      const session = createMockSession({
        videoStream: { VideoRangeType: 'DOVIWithHDR10' },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('Dolby Vision');
    });

    it('detects SDR from VideoRangeType', () => {
      const session = createMockSession({
        videoStream: { VideoRangeType: 'SDR', BitDepth: 8 },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('SDR');
    });

    it('falls back to ColorTransfer for HDR10 detection', () => {
      const session = createMockSession({
        videoStream: {
          VideoRangeType: undefined,
          VideoRange: 'HDR',
          ColorTransfer: 'smpte2084',
        },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('HDR10');
    });

    it('falls back to ColorTransfer for HLG detection', () => {
      const session = createMockSession({
        videoStream: {
          VideoRangeType: undefined,
          VideoRange: 'HDR',
          ColorTransfer: 'arib-std-b67',
        },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('HLG');
    });

    it('detects HDR from bt2020 color space', () => {
      const session = createMockSession({
        videoStream: {
          VideoRangeType: undefined,
          VideoRange: undefined,
          ColorSpace: 'bt2020nc',
          ColorTransfer: undefined,
          BitDepth: 10,
        },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('HDR');
    });

    it('returns SDR for 8-bit bt709 content', () => {
      const session = createMockSession({
        videoStream: {
          VideoRangeType: undefined,
          VideoRange: undefined,
          ColorSpace: 'bt709',
          BitDepth: 8,
        },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceVideoDetails?.dynamicRange).toBe('SDR');
    });
  });

  describe('source audio details', () => {
    it('extracts audio codec in uppercase', () => {
      const session = createMockSession({ audioStream: { Codec: 'truehd' } });
      const result = extractStreamDetails(session);
      expect(result.sourceAudioCodec).toBe('TRUEHD');
    });

    it('extracts audio channels', () => {
      const session = createMockSession({ audioStream: { Channels: 8 } });
      const result = extractStreamDetails(session);
      expect(result.sourceAudioChannels).toBe(8);
    });

    it('extracts audio bitrate in kbps', () => {
      const session = createMockSession({
        audioStream: { BitRate: 5000000 }, // 5 Mbps in bps
      });
      const result = extractStreamDetails(session);
      expect(result.sourceAudioDetails?.bitrate).toBe(5000); // 5000 kbps
    });

    it('extracts channel layout', () => {
      const session = createMockSession({
        audioStream: { ChannelLayout: '7.1' },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceAudioDetails?.channelLayout).toBe('7.1');
    });

    it('extracts audio language', () => {
      const session = createMockSession({
        audioStream: { Language: 'eng' },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceAudioDetails?.language).toBe('eng');
    });

    it('extracts sample rate', () => {
      const session = createMockSession({
        audioStream: { SampleRate: 48000 },
      });
      const result = extractStreamDetails(session);
      expect(result.sourceAudioDetails?.sampleRate).toBe(48000);
    });
  });

  describe('subtitle info', () => {
    it('extracts subtitle codec in uppercase', () => {
      const session = createMockSession({
        subtitleStream: { Codec: 'srt' },
      });
      const result = extractStreamDetails(session);
      expect(result.subtitleInfo?.codec).toBe('SRT');
    });

    it('extracts subtitle language', () => {
      const session = createMockSession({
        subtitleStream: { Language: 'spa' },
      });
      const result = extractStreamDetails(session);
      expect(result.subtitleInfo?.language).toBe('spa');
    });

    it('extracts forced subtitle flag', () => {
      const session = createMockSession({
        subtitleStream: { IsForced: true },
      });
      const result = extractStreamDetails(session);
      expect(result.subtitleInfo?.forced).toBe(true);
    });

    it('returns undefined when no subtitle stream', () => {
      const session = createMockSession();
      const result = extractStreamDetails(session);
      expect(result.subtitleInfo).toBeUndefined();
    });
  });

  describe('transcode info', () => {
    it('extracts source container in uppercase', () => {
      const session = createMockSession({ container: 'mkv' });
      const result = extractStreamDetails(session);
      expect(result.transcodeInfo?.sourceContainer).toBe('MKV');
    });

    it('extracts stream container when transcoding', () => {
      const session = createMockSession({
        transcodingInfo: { Container: 'ts' },
      });
      const result = extractStreamDetails(session);
      expect(result.transcodeInfo?.streamContainer).toBe('TS');
    });

    it('sets containerDecision to direct when containers match', () => {
      const session = createMockSession({
        container: 'mp4',
        transcodingInfo: { Container: 'mp4' },
      });
      const result = extractStreamDetails(session);
      expect(result.transcodeInfo?.containerDecision).toBe('direct');
    });

    it('sets containerDecision to transcode when containers differ', () => {
      const session = createMockSession({
        container: 'mkv',
        transcodingInfo: { Container: 'ts' },
      });
      const result = extractStreamDetails(session);
      expect(result.transcodeInfo?.containerDecision).toBe('transcode');
    });
  });

  describe('stream output details (after transcode)', () => {
    it('extracts transcoded video codec', () => {
      const session = createMockSession({
        transcodingInfo: { VideoCodec: 'h264' },
      });
      const result = extractStreamDetails(session);
      expect(result.streamVideoCodec).toBe('H264');
    });

    it('extracts transcoded audio codec', () => {
      const session = createMockSession({
        transcodingInfo: { AudioCodec: 'aac' },
      });
      const result = extractStreamDetails(session);
      expect(result.streamAudioCodec).toBe('AAC');
    });

    it('extracts transcoded resolution', () => {
      const session = createMockSession({
        transcodingInfo: { Width: 1920, Height: 1080 },
      });
      const result = extractStreamDetails(session);
      expect(result.streamVideoDetails?.width).toBe(1920);
      expect(result.streamVideoDetails?.height).toBe(1080);
    });

    it('extracts transcoded audio channels', () => {
      const session = createMockSession({
        transcodingInfo: { AudioChannels: 2 },
      });
      const result = extractStreamDetails(session);
      expect(result.streamAudioDetails?.channels).toBe(2);
    });

    it('falls back to source codec when not transcoding', () => {
      const session = createMockSession({
        videoStream: { Codec: 'hevc' },
        audioStream: { Codec: 'truehd' },
      });
      const result = extractStreamDetails(session);
      expect(result.streamVideoCodec).toBe('HEVC');
      expect(result.streamAudioCodec).toBe('TRUEHD');
    });

    it('returns empty stream details when direct playing', () => {
      const session = createMockSession();
      const result = extractStreamDetails(session);
      expect(result.streamVideoDetails).toBeUndefined();
      expect(result.streamAudioDetails).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty session', () => {
      const result = extractStreamDetails({});
      expect(result.sourceVideoCodec).toBeUndefined();
      expect(result.sourceAudioCodec).toBeUndefined();
    });

    it('handles missing MediaSources', () => {
      const session = { NowPlayingItem: {} };
      const result = extractStreamDetails(session);
      expect(result.sourceVideoCodec).toBeUndefined();
    });

    it('handles empty MediaStreams array', () => {
      const session = {
        NowPlayingItem: {
          MediaSources: [{ MediaStreams: [] }],
        },
      };
      const result = extractStreamDetails(session);
      expect(result.sourceVideoCodec).toBeUndefined();
      expect(result.sourceAudioCodec).toBeUndefined();
    });

    it('prefers default stream when multiple of same type', () => {
      const session = {
        NowPlayingItem: {
          MediaSources: [
            {
              MediaStreams: [
                { Type: 'Audio', Codec: 'ac3', Channels: 6, IsDefault: false },
                { Type: 'Audio', Codec: 'truehd', Channels: 8, IsDefault: true },
                { Type: 'Audio', Codec: 'aac', Channels: 2, IsDefault: false },
              ],
            },
          ],
        },
      };
      const result = extractStreamDetails(session);
      expect(result.sourceAudioCodec).toBe('TRUEHD');
      expect(result.sourceAudioChannels).toBe(8);
    });

    it('falls back to first stream when no default', () => {
      const session = {
        NowPlayingItem: {
          MediaSources: [
            {
              MediaStreams: [
                { Type: 'Audio', Codec: 'ac3', Channels: 6, IsDefault: false },
                { Type: 'Audio', Codec: 'truehd', Channels: 8, IsDefault: false },
              ],
            },
          ],
        },
      };
      const result = extractStreamDetails(session);
      expect(result.sourceAudioCodec).toBe('AC3');
      expect(result.sourceAudioChannels).toBe(6);
    });
  });
});

// ============================================================================
// getBitrate Tests
// ============================================================================

describe('getBitrate', () => {
  it('returns TranscodingInfo.Bitrate when available', () => {
    const session = {
      TranscodingInfo: { Bitrate: 8000000 }, // 8 Mbps in bps
    };
    expect(getBitrate(session)).toBe(8000); // 8000 kbps
  });

  it('falls back to MediaSources[0].Bitrate', () => {
    const session = {
      NowPlayingItem: {
        MediaSources: [{ Bitrate: 20000000 }], // 20 Mbps in bps
      },
    };
    expect(getBitrate(session)).toBe(20000); // 20000 kbps
  });

  it('falls back to video stream BitRate', () => {
    const session = {
      NowPlayingItem: {
        MediaStreams: [
          { Type: 'Video', BitRate: 15000000 }, // 15 Mbps in bps
        ],
      },
    };
    expect(getBitrate(session)).toBe(15000); // 15000 kbps
  });

  it('falls back to NowPlayingItem.Bitrate (Emby)', () => {
    const session = {
      NowPlayingItem: {
        Bitrate: 10000000, // 10 Mbps in bps
      },
    };
    expect(getBitrate(session)).toBe(10000); // 10000 kbps
  });

  it('calculates bitrate from file size and duration when not explicitly provided', () => {
    // 1 hour video (36,000,000,000 ticks = 1 hour)
    // 4.5 GB file = 4,500,000,000 bytes
    // Expected bitrate: (4,500,000,000 * 8 * 10000) / 36,000,000,000 = 10000 kbps
    const session = {
      NowPlayingItem: {
        RunTimeTicks: 36000000000, // 1 hour in ticks
        MediaSources: [{ Size: 4500000000 }], // 4.5 GB
      },
    };
    expect(getBitrate(session)).toBe(10000); // 10 Mbps
  });

  it('returns 0 when no bitrate info available', () => {
    const session = { NowPlayingItem: {} };
    expect(getBitrate(session)).toBe(0);
  });
});
