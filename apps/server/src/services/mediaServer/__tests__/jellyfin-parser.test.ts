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
  parseAuthResponse,
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
    parseAuthResponse,
  },
  'jellyfin'
);

// ============================================================================
// Jellyfin-Specific: DirectStream Handling
// ============================================================================

describe('Jellyfin Parser - DirectStream Behavior', () => {
  it('should normalize DirectStream to copy (remux)', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        PlayMethod: 'DirectStream',
        IsPaused: false,
      },
    });

    expect(session!.quality.isTranscode).toBe(false);
    // Jellyfin normalizes DirectStream to 'copy' (video/audio streams copied, container may change)
    expect(session!.quality.videoDecision).toBe('copy');
  });

  it('should fall back to TranscodingInfo when PlayMethod not available', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
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
