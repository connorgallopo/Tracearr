import { describe, expect, it } from 'vitest';
import type { ProcessedSession } from '../types.js';
import { pickLiveSessionFields } from '../sessionMapper.js';

const processed = {
  sessionKey: 'sk',
  state: 'paused',
  mediaType: 'episode',
  mediaTitle: 'Ep',
  grandparentTitle: 'Show',
  seasonNumber: 2,
  episodeNumber: 5,
  year: 2021,
  thumbPath: '/t.jpg',
  totalDurationMs: 100,
  progressMs: 0,
  playerName: 'P',
  deviceId: '',
  product: undefined,
  device: 'TV',
  platform: 'tvOS',
  quality: '1080p',
  isTranscode: true,
  videoDecision: 'transcode',
  audioDecision: 'copy',
  bitrate: 8000,
  sourceVideoCodec: 'hevc',
  sourceAudioCodec: 'eac3',
  sourceAudioChannels: 6,
  sourceVideoDetails: null,
  sourceAudioDetails: null,
  streamVideoCodec: 'h264',
  streamAudioCodec: 'aac',
  streamVideoDetails: null,
  streamAudioDetails: null,
  transcodeInfo: null,
  subtitleInfo: null,
  ipAddress: '1.1.1.1',
} as unknown as ProcessedSession;

describe('pickLiveSessionFields', () => {
  it('picks exactly the fields the twins took from processed, with the twins normalization', () => {
    const live = pickLiveSessionFields(processed);
    expect(live).toMatchObject({
      state: 'paused',
      mediaType: 'episode',
      mediaTitle: 'Ep',
      grandparentTitle: 'Show',
      seasonNumber: 2,
      episodeNumber: 5,
      year: 2021,
      thumbPath: '/t.jpg',
      totalDurationMs: 100,
      progressMs: null,
      playerName: 'P',
      deviceId: null,
      product: null,
      device: 'TV',
      platform: 'tvOS',
      quality: '1080p',
      isTranscode: true,
      videoDecision: 'transcode',
      audioDecision: 'copy',
      bitrate: 8000,
      sourceVideoCodec: 'hevc',
      streamVideoCodec: 'h264',
    });
    expect('ipAddress' in live).toBe(false);
    expect('id' in live).toBe(false);
  });
});
