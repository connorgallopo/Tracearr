import { describe, it, expect } from 'vitest';
import { resolveTargetSessions } from '../executors/targeting.js';
import type { Session } from '@tracearr/shared';

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    sessionKey: 'abc123',
    serverId: 'server-1',
    serverUserId: 'user-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: '12345',
    serverVersionKey: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    mediaId: null,
    showMediaId: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    externalSessionId: null,
    startedAt: new Date('2024-01-01T10:00:00Z'),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 3600000,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '192.168.1.100',
    geoCity: null,
    geoRegion: null,
    geoCountry: null,
    geoContinent: null,
    geoPostal: null,
    geoLat: null,
    geoLon: null,
    geoAsnNumber: null,
    geoAsnOrganization: null,
    isLocal: false,
    profileName: null,
    playerName: 'Living Room TV',
    deviceId: 'device-123',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Windows',
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 20000,
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    sourceVideoCodec: null,
    sourceAudioCodec: null,
    sourceAudioChannels: null,
    sourceVideoWidth: null,
    sourceVideoHeight: null,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  };
}

describe('resolveTargetSessions', () => {
  const userId = 'user-1';
  const otherUserId = 'user-2';

  const oldestSession = createMockSession({
    id: 'oldest',
    serverUserId: userId,
    startedAt: new Date('2024-01-01T08:00:00Z'),
  });
  const middleSession = createMockSession({
    id: 'middle',
    serverUserId: userId,
    startedAt: new Date('2024-01-01T09:00:00Z'),
  });
  const newestSession = createMockSession({
    id: 'newest',
    serverUserId: userId,
    startedAt: new Date('2024-01-01T10:00:00Z'),
  });
  const otherUserSession = createMockSession({
    id: 'other-user',
    serverUserId: otherUserId,
    startedAt: new Date('2024-01-01T09:30:00Z'),
  });

  const allSessions = [oldestSession, middleSession, newestSession, otherUserSession];

  describe('target: triggering', () => {
    it('should return only the triggering session', () => {
      const result = resolveTargetSessions({
        target: 'triggering',
        triggeringSession: middleSession,
        serverUserId: userId,
        activeSessions: allSessions,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('middle');
    });
  });

  describe('target: oldest', () => {
    it('should return the oldest session for this user', () => {
      const result = resolveTargetSessions({
        target: 'oldest',
        triggeringSession: newestSession,
        serverUserId: userId,
        activeSessions: allSessions,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('oldest');
    });

    it('should return empty array if user has no sessions', () => {
      const result = resolveTargetSessions({
        target: 'oldest',
        triggeringSession: newestSession,
        serverUserId: 'nonexistent-user',
        activeSessions: allSessions,
      });
      expect(result).toHaveLength(0);
    });
  });

  describe('target: newest', () => {
    it('should return the newest session for this user', () => {
      const result = resolveTargetSessions({
        target: 'newest',
        triggeringSession: oldestSession,
        serverUserId: userId,
        activeSessions: allSessions,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('newest');
    });
  });

  describe('target: all_except_one', () => {
    it('should return all but the oldest session (keep oldest)', () => {
      const result = resolveTargetSessions({
        target: 'all_except_one',
        triggeringSession: newestSession,
        serverUserId: userId,
        activeSessions: allSessions,
      });
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.id)).toEqual(['middle', 'newest']);
    });

    it('should return empty array if user has only one session', () => {
      const result = resolveTargetSessions({
        target: 'all_except_one',
        triggeringSession: oldestSession,
        serverUserId: userId,
        activeSessions: [oldestSession, otherUserSession],
      });
      expect(result).toHaveLength(0);
    });
  });

  describe('target: all_user', () => {
    it('should return all sessions for this user', () => {
      const result = resolveTargetSessions({
        target: 'all_user',
        triggeringSession: newestSession,
        serverUserId: userId,
        activeSessions: allSessions,
      });
      expect(result).toHaveLength(3);
      expect(result.map((s) => s.id)).toEqual(['oldest', 'middle', 'newest']);
    });

    it('should not include other users sessions', () => {
      const result = resolveTargetSessions({
        target: 'all_user',
        triggeringSession: newestSession,
        serverUserId: userId,
        activeSessions: allSessions,
      });
      expect(result.every((s) => s.serverUserId === userId)).toBe(true);
    });
  });

  describe('default behavior', () => {
    it('should default to triggering for undefined target', () => {
      const result = resolveTargetSessions({
        target: undefined,
        triggeringSession: middleSession,
        serverUserId: userId,
        activeSessions: allSessions,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('middle');
    });
  });

  describe('identityServerUserIds (opt-in cross-server enforcement)', () => {
    it('ignores sibling-account sessions when identityServerUserIds is absent (default off)', () => {
      const result = resolveTargetSessions({
        target: 'all_user',
        triggeringSession: newestSession,
        serverUserId: userId,
        activeSessions: allSessions,
      });
      expect(result.every((s) => s.serverUserId === userId)).toBe(true);
      expect(result.some((s) => s.id === 'other-user')).toBe(false);
    });

    it('includes sibling-account sessions when identityServerUserIds is set', () => {
      const result = resolveTargetSessions({
        target: 'all_user',
        triggeringSession: newestSession,
        serverUserId: userId,
        activeSessions: allSessions,
        identityServerUserIds: [userId, otherUserId],
      });
      expect(result.map((s) => s.id).sort()).toEqual(
        ['middle', 'newest', 'oldest', 'other-user'].sort()
      );
    });

    it('falls back to serverUserId matching when identityServerUserIds is an empty array', () => {
      const result = resolveTargetSessions({
        target: 'all_user',
        triggeringSession: newestSession,
        serverUserId: userId,
        activeSessions: allSessions,
        identityServerUserIds: [],
      });
      expect(result.every((s) => s.serverUserId === userId)).toBe(true);
    });
  });
});
