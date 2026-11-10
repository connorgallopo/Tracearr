import { describe, expect, it } from 'vitest';
import { buildCompositeKey } from '../sessionIdentity.js';
import { shouldWriteToDb } from '../stateTracker.js';
import { calculatePendingPauseAccumulation } from '../pendingConfirmation.js';

describe('JF/Emby session lifecycle integration', () => {
  describe('restart scenario (#597)', () => {
    it('composite key is stable across session.Id changes', () => {
      const before = buildCompositeKey({
        serverType: 'jellyfin',
        serverId: 'srv-1',
        externalUserId: 'user-1',
        deviceId: 'device-1',
        ratingKey: 'movie-abc',
        sessionKey: 'old-session-id',
      });

      const after = buildCompositeKey({
        serverType: 'jellyfin',
        serverId: 'srv-1',
        externalUserId: 'user-1',
        deviceId: 'device-1',
        ratingKey: 'movie-abc',
        sessionKey: 'new-session-id',
      });

      expect(before).toBe(after);
    });

    it('different content produces different key', () => {
      const movie1 = buildCompositeKey({
        serverType: 'jellyfin',
        serverId: 'srv-1',
        externalUserId: 'user-1',
        deviceId: 'device-1',
        ratingKey: 'movie-abc',
        sessionKey: 'session-1',
      });

      const movie2 = buildCompositeKey({
        serverType: 'jellyfin',
        serverId: 'srv-1',
        externalUserId: 'user-1',
        deviceId: 'device-1',
        ratingKey: 'movie-def',
        sessionKey: 'session-2',
      });

      expect(movie1).not.toBe(movie2);
    });

    it('different users produce different keys for same content', () => {
      const user1 = buildCompositeKey({
        serverType: 'emby',
        serverId: 'srv-1',
        externalUserId: 'user-1',
        deviceId: 'device-1',
        ratingKey: 'movie-abc',
        sessionKey: 's1',
      });

      const user2 = buildCompositeKey({
        serverType: 'emby',
        serverId: 'srv-1',
        externalUserId: 'user-2',
        deviceId: 'device-1',
        ratingKey: 'movie-abc',
        sessionKey: 's2',
      });

      expect(user1).not.toBe(user2);
    });
  });

  describe('Plex isolation', () => {
    it('Plex ignores userId and deviceId', () => {
      const key = buildCompositeKey({
        serverType: 'plex',
        serverId: 'plex-srv',
        externalUserId: 'user-1',
        deviceId: 'device-1',
        ratingKey: 'movie-1',
        sessionKey: 'plex-key',
      });

      expect(key).toBe('plex-srv:plex-key');
      expect(key).not.toContain('user-1');
    });
  });

  describe('change detection', () => {
    const base = {
      state: 'playing',
      isTranscode: false,
      videoDecision: 'direct play',
      audioDecision: 'direct play',
      watched: false,
      sourceVideoCodec: 'h264',
      sourceAudioCodec: 'aac',
    };

    it('skips write for progress-only updates', () => {
      expect(shouldWriteToDb(base, { ...base })).toBe(false);
    });

    it('forces write on state change', () => {
      expect(shouldWriteToDb(base, { ...base, state: 'paused' })).toBe(true);
    });

    it('forces write on transcode change', () => {
      expect(shouldWriteToDb(base, { ...base, isTranscode: true })).toBe(true);
    });
  });

  describe('pending session pause tracking', () => {
    it('accumulates pause time across transitions', () => {
      const now = 1000000;

      // Play → Pause
      const paused = calculatePendingPauseAccumulation({
        previousState: 'playing',
        newState: 'paused',
        pausedDurationMs: 0,
        lastPausedAt: null,
        now,
      });
      expect(paused.lastPausedAt).toBe(now);
      expect(paused.pausedDurationMs).toBe(0);

      // Pause → Play (5s later)
      const resumed = calculatePendingPauseAccumulation({
        previousState: 'paused',
        newState: 'playing',
        pausedDurationMs: paused.pausedDurationMs,
        lastPausedAt: paused.lastPausedAt,
        now: now + 5000,
      });
      expect(resumed.lastPausedAt).toBeNull();
      expect(resumed.pausedDurationMs).toBe(5000);
    });
  });
});
