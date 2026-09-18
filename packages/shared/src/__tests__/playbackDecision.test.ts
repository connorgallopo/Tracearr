import { describe, expect, it } from 'vitest';
import { playbackDecision } from '../playbackDecision.js';

describe('playbackDecision', () => {
  it('is a transcode whenever the session transcodes, whatever the stream decisions say', () => {
    expect(playbackDecision({ isTranscode: true, videoDecision: 'copy' })).toBe('transcode');
  });

  it('is a direct stream when either stream is copied', () => {
    expect(playbackDecision({ videoDecision: 'copy', audioDecision: 'directplay' })).toBe('copy');
    expect(playbackDecision({ videoDecision: 'directplay', audioDecision: 'copy' })).toBe('copy');
  });

  it('is direct play otherwise, including when the decisions are absent', () => {
    expect(playbackDecision({ videoDecision: 'directplay', audioDecision: 'directplay' })).toBe(
      'directplay'
    );
    expect(playbackDecision({ isTranscode: null, videoDecision: null })).toBe('directplay');
  });
});
