/**
 * Plex Parser Unit Tests
 *
 * Tests for internal parser functions that handle media stream
 * metadata extraction and HDR detection.
 */

import { describe, it, expect } from 'vitest';
import { findStreamByType, deriveDynamicRange, STREAM_TYPE } from '../plex/parser.js';

// ============================================================================
// findStreamByType Tests
// ============================================================================

describe('findStreamByType', () => {
  describe('edge cases', () => {
    it('should return undefined for undefined part', () => {
      expect(findStreamByType(undefined, STREAM_TYPE.VIDEO)).toBeUndefined();
    });

    it('should return undefined for part without Stream array', () => {
      expect(findStreamByType({}, STREAM_TYPE.VIDEO)).toBeUndefined();
      expect(findStreamByType({ Stream: null }, STREAM_TYPE.VIDEO)).toBeUndefined();
      expect(findStreamByType({ Stream: 'not-an-array' }, STREAM_TYPE.VIDEO)).toBeUndefined();
    });

    it('should return undefined when no streams match the type', () => {
      const part = {
        Stream: [
          { streamType: '2', codec: 'aac' }, // Audio
          { streamType: '3', codec: 'srt' }, // Subtitle
        ],
      };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBeUndefined();
    });

    it('should return undefined for empty Stream array', () => {
      const part = { Stream: [] };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBeUndefined();
    });
  });

  describe('single stream selection', () => {
    it('should return the only matching stream', () => {
      const videoStream = { streamType: '1', codec: 'hevc' };
      const part = { Stream: [videoStream] };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBe(videoStream);
    });

    it('should return first matching stream when multiple exist and none selected', () => {
      const stream1 = { streamType: '1', codec: 'hevc', index: 0 };
      const stream2 = { streamType: '1', codec: 'h264', index: 1 };
      const part = { Stream: [stream1, stream2] };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBe(stream1);
    });
  });

  describe('selected stream preference', () => {
    it('should prefer selected stream over first', () => {
      const stream1 = { streamType: '1', codec: 'hevc', index: 0 };
      const selectedStream = { streamType: '1', codec: 'h264', index: 1, selected: '1' };
      const part = { Stream: [stream1, selectedStream] };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBe(selectedStream);
    });

    it('should return selected stream when it appears first', () => {
      const selectedStream = { streamType: '1', codec: 'hevc', selected: '1' };
      const stream2 = { streamType: '1', codec: 'h264' };
      const part = { Stream: [selectedStream, stream2] };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBe(selectedStream);
    });

    it('should handle selected=0 as not selected', () => {
      const stream1 = { streamType: '1', codec: 'hevc', selected: '0', index: 0 };
      const stream2 = { streamType: '1', codec: 'h264', index: 1 };
      const part = { Stream: [stream1, stream2] };
      // Should return first match since selected='0' is not truthy
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBe(stream1);
    });
  });

  describe('stream type filtering', () => {
    it('should find video streams (type 1)', () => {
      const videoStream = { streamType: '1', codec: 'hevc' };
      const audioStream = { streamType: '2', codec: 'aac' };
      const part = { Stream: [audioStream, videoStream] };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBe(videoStream);
    });

    it('should find audio streams (type 2)', () => {
      const videoStream = { streamType: '1', codec: 'hevc' };
      const audioStream = { streamType: '2', codec: 'truehd' };
      const part = { Stream: [videoStream, audioStream] };
      expect(findStreamByType(part, STREAM_TYPE.AUDIO)).toBe(audioStream);
    });

    it('should find subtitle streams (type 3)', () => {
      const videoStream = { streamType: '1', codec: 'hevc' };
      const subtitleStream = { streamType: '3', codec: 'srt' };
      const part = { Stream: [videoStream, subtitleStream] };
      expect(findStreamByType(part, STREAM_TYPE.SUBTITLE)).toBe(subtitleStream);
    });
  });

  describe('numeric vs string streamType', () => {
    it('should handle numeric streamType values', () => {
      const videoStream = { streamType: 1, codec: 'hevc' };
      const part = { Stream: [videoStream] };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBe(videoStream);
    });

    it('should handle string streamType values', () => {
      const videoStream = { streamType: '1', codec: 'hevc' };
      const part = { Stream: [videoStream] };
      expect(findStreamByType(part, STREAM_TYPE.VIDEO)).toBe(videoStream);
    });
  });
});

// ============================================================================
// deriveDynamicRange Tests
// ============================================================================

describe('deriveDynamicRange', () => {
  describe('Dolby Vision detection', () => {
    it('should detect Dolby Vision with profile', () => {
      const stream = { DOVIPresent: '1', DOVIProfile: '8.1' };
      expect(deriveDynamicRange(stream)).toBe('Dolby Vision 8.1');
    });

    it('should detect Dolby Vision without profile', () => {
      const stream = { DOVIPresent: '1' };
      expect(deriveDynamicRange(stream)).toBe('Dolby Vision');
    });

    it('should detect Dolby Vision profile 5', () => {
      const stream = { DOVIPresent: '1', DOVIProfile: '5' };
      expect(deriveDynamicRange(stream)).toBe('Dolby Vision 5');
    });

    it('should not detect Dolby Vision when DOVIPresent is 0', () => {
      const stream = { DOVIPresent: '0', colorSpace: 'bt2020', colorTrc: 'smpte2084' };
      expect(deriveDynamicRange(stream)).toBe('HDR10');
    });
  });

  describe('HDR10 detection via color attributes', () => {
    it('should detect HDR10 via bt2020 + smpte2084', () => {
      const stream = { colorSpace: 'bt2020', colorTrc: 'smpte2084' };
      expect(deriveDynamicRange(stream)).toBe('HDR10');
    });

    it('should detect HDR10 via bitDepth 10 + smpte2084', () => {
      const stream = { bitDepth: 10, colorTrc: 'smpte2084' };
      expect(deriveDynamicRange(stream)).toBe('HDR10');
    });

    it('should detect HDR10 via bitDepth 12 + smpte2084', () => {
      const stream = { bitDepth: 12, colorTrc: 'smpte2084' };
      expect(deriveDynamicRange(stream)).toBe('HDR10');
    });
  });

  describe('HLG detection via color attributes', () => {
    it('should detect HLG via bt2020 + arib-std-b67', () => {
      const stream = { colorSpace: 'bt2020', colorTrc: 'arib-std-b67' };
      expect(deriveDynamicRange(stream)).toBe('HLG');
    });

    it('should detect HLG via bitDepth 10 + arib-std-b67', () => {
      const stream = { bitDepth: 10, colorTrc: 'arib-std-b67' };
      expect(deriveDynamicRange(stream)).toBe('HLG');
    });
  });

  describe('Generic HDR detection', () => {
    it('should detect HDR via bt2020 without specific TRC', () => {
      const stream = { colorSpace: 'bt2020' };
      expect(deriveDynamicRange(stream)).toBe('HDR');
    });

    it('should detect HDR via bt2020 with unknown TRC', () => {
      const stream = { colorSpace: 'bt2020', colorTrc: 'unknown-trc' };
      expect(deriveDynamicRange(stream)).toBe('HDR');
    });
  });

  describe('extendedDisplayTitle fallback detection', () => {
    it('should detect Dolby Vision from extendedDisplayTitle', () => {
      const stream = { extendedDisplayTitle: '4K (HEVC Main 10 Dolby Vision Profile 8)' };
      expect(deriveDynamicRange(stream)).toBe('Dolby Vision');
    });

    it('should detect DoVi abbreviation from extendedDisplayTitle', () => {
      const stream = { extendedDisplayTitle: '4K (HEVC DoVi)' };
      expect(deriveDynamicRange(stream)).toBe('Dolby Vision');
    });

    it('should detect HLG from extendedDisplayTitle', () => {
      const stream = { extendedDisplayTitle: '4K (HEVC Main 10 HLG)' };
      expect(deriveDynamicRange(stream)).toBe('HLG');
    });

    it('should detect HDR10 from extendedDisplayTitle', () => {
      const stream = { extendedDisplayTitle: '4K (HEVC Main 10 HDR10)' };
      expect(deriveDynamicRange(stream)).toBe('HDR10');
    });

    it('should detect generic HDR from extendedDisplayTitle', () => {
      const stream = { extendedDisplayTitle: '4K (HEVC Main 10 HDR)' };
      expect(deriveDynamicRange(stream)).toBe('HDR');
    });

    it('should not false-positive on "HDR10" when checking for "HDR"', () => {
      // extendedDisplayTitle contains 'HDR10' which also contains 'HDR'
      // The function checks HDR10 first, so it should return HDR10
      const stream = { extendedDisplayTitle: '4K HDR10' };
      expect(deriveDynamicRange(stream)).toBe('HDR10');
    });
  });

  describe('SDR detection', () => {
    it('should return SDR for standard content', () => {
      const stream = { colorSpace: 'bt709' };
      expect(deriveDynamicRange(stream)).toBe('SDR');
    });

    it('should return SDR for 8-bit content', () => {
      const stream = { bitDepth: 8 };
      expect(deriveDynamicRange(stream)).toBe('SDR');
    });

    it('should return SDR for empty stream', () => {
      expect(deriveDynamicRange({})).toBe('SDR');
    });

    it('should return SDR when extendedDisplayTitle has no HDR keywords', () => {
      const stream = { extendedDisplayTitle: '1080p (H264)' };
      expect(deriveDynamicRange(stream)).toBe('SDR');
    });
  });

  describe('priority order', () => {
    it('should prioritize Dolby Vision over HDR10 attributes', () => {
      // Has both DOVI and HDR10 attributes - DOVI should win
      const stream = {
        DOVIPresent: '1',
        DOVIProfile: '7',
        colorSpace: 'bt2020',
        colorTrc: 'smpte2084',
      };
      expect(deriveDynamicRange(stream)).toBe('Dolby Vision 7');
    });

    it('should prioritize color attributes over extendedDisplayTitle', () => {
      // Has bt2020+smpte2084 (HDR10) but extendedDisplayTitle says HLG
      const stream = {
        colorSpace: 'bt2020',
        colorTrc: 'smpte2084',
        extendedDisplayTitle: '4K HLG',
      };
      expect(deriveDynamicRange(stream)).toBe('HDR10');
    });
  });
});
