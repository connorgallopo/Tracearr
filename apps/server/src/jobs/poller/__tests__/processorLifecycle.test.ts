import { describe, expect, it } from 'vitest';
import { buildCompositeKey } from '../sessionIdentity.js';
import { shouldWriteToDb } from '../stateTracker.js';
import { updatePendingSession } from '../pendingConfirmation.js';
import { PLAYBACK_CONFIRM_THRESHOLD_MS, DB_WRITE_FLUSH_INTERVAL_MS } from '../types.js';
import {
  getEffectiveFlushIntervalMs,
  recordDbWrite,
  shouldFlushDbWrite,
} from '../dbWriteThrottle.js';
import type { PendingSessionData } from '../types.js';

// Helper to create a base pending session for tests
function createPendingSession(overrides: Partial<PendingSessionData> = {}): PendingSessionData {
  const now = 1710600000000;
  return {
    id: 'test-uuid-123',
    confirmation: {
      confirmedPlayback: false,
      firstSeenAt: now,
      maxViewOffset: 0,
      initialViewOffset: null,
    },
    processed: {} as any,
    server: { id: 'srv-1', name: 'Test JF', type: 'jellyfin' },
    serverUser: {
      id: 'su-1',
      userId: 'identity-1',
      username: 'testuser',
      thumbUrl: null,
      identityName: null,
      trustScore: 100,
      lastActivityAt: null,
      createdAt: new Date(),
      identityServerUserIds: ['su-1'],
    },
    geo: {} as any,
    currentState: 'playing',
    startedAt: now,
    pausedDurationMs: 0,
    lastPausedAt: null,
    lastSeenAt: now,
    ...overrides,
  };
}

// ============================================================================
// 1. Session restart with composite key (#597 core fix)
// ============================================================================

describe('session restart with composite keys (#597)', () => {
  it('composite key is identical when session.Id changes on restart', () => {
    const before = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'su-internal-uuid',
      deviceId: 'device-abc',
      ratingKey: 'movie-123',
      sessionKey: 'old-jellyfin-session-id',
    });

    const after = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'su-internal-uuid',
      deviceId: 'device-abc',
      ratingKey: 'movie-123',
      sessionKey: 'new-jellyfin-session-id',
    });

    expect(before).toBe(after);
    expect(before).not.toContain('old-jellyfin-session-id');
    expect(before).not.toContain('new-jellyfin-session-id');
  });

  it('Plex key DOES change when sessionKey changes', () => {
    const before = buildCompositeKey({
      serverType: 'plex',
      serverId: 'srv-1',
      externalUserId: 'user-1',
      deviceId: 'device-1',
      ratingKey: 'movie-1',
      sessionKey: 'plex-key-A',
    });

    const after = buildCompositeKey({
      serverType: 'plex',
      serverId: 'srv-1',
      externalUserId: 'user-1',
      deviceId: 'device-1',
      ratingKey: 'movie-1',
      sessionKey: 'plex-key-B',
    });

    expect(before).not.toBe(after);
  });

  it('Emby restart also produces stable composite key', () => {
    const before = buildCompositeKey({
      serverType: 'emby',
      serverId: 'srv-2',
      externalUserId: 'user-emby',
      deviceId: 'emby-device',
      ratingKey: 'show-ep-5',
      sessionKey: 'emby-session-old',
    });

    const after = buildCompositeKey({
      serverType: 'emby',
      serverId: 'srv-2',
      externalUserId: 'user-emby',
      deviceId: 'emby-device',
      ratingKey: 'show-ep-5',
      sessionKey: 'emby-session-new',
    });

    expect(before).toBe(after);
  });
});

// ============================================================================
// 2. Phantom session filtering (pending → disappeared within 30s)
// ============================================================================

describe('phantom session filtering', () => {
  it('session under 30s is not confirmed (would be discarded if it disappears)', () => {
    const pending = createPendingSession();
    const at15s = pending.startedAt + 15000;

    const { isConfirmed } = updatePendingSession(pending, 'playing', 15000, at15s);
    expect(isConfirmed).toBe(false);
  });

  it('session just past 30s of progress is confirmed', () => {
    const pending = createPendingSession();
    const at31s = pending.startedAt + PLAYBACK_CONFIRM_THRESHOLD_MS + 1;

    const { isConfirmed } = updatePendingSession(
      pending,
      'playing',
      PLAYBACK_CONFIRM_THRESHOLD_MS + 1,
      at31s
    );
    expect(isConfirmed).toBe(true);
  });

  it('session at exactly 30s is not yet confirmed (requires > 30s)', () => {
    const pending = createPendingSession();
    const at30s = pending.startedAt + PLAYBACK_CONFIRM_THRESHOLD_MS;

    const { isConfirmed } = updatePendingSession(
      pending,
      'playing',
      PLAYBACK_CONFIRM_THRESHOLD_MS,
      at30s
    );
    expect(isConfirmed).toBe(false);
  });

  it('session confirmed by elapsed time even without progress', () => {
    const pending = createPendingSession();
    const at31s = pending.startedAt + PLAYBACK_CONFIRM_THRESHOLD_MS + 1;

    const { isConfirmed } = updatePendingSession(pending, 'playing', 0, at31s);
    expect(isConfirmed).toBe(true);
  });

  it('paused session is confirmed after 30s wall-clock time', () => {
    const pending = createPendingSession({ currentState: 'paused' });
    const at35s = pending.startedAt + 35000;

    // Paused sessions confirm after 30s wall-clock time (state-independent)
    const { isConfirmed } = updatePendingSession(pending, 'paused', 0, at35s);
    expect(isConfirmed).toBe(true);
  });
});

// ============================================================================
// 3. Rapid restarts while pending
// ============================================================================

describe('rapid restarts while pending', () => {
  it('composite key matches across rapid restarts (pending session updated, not duplicated)', () => {
    // Simulate 3 rapid restarts of the same content
    const keys = ['session-1', 'session-2', 'session-3'].map((sk) =>
      buildCompositeKey({
        serverType: 'jellyfin',
        serverId: 'srv-1',
        externalUserId: 'user-1',
        deviceId: 'device-1',
        ratingKey: 'movie-abc',
        sessionKey: sk,
      })
    );

    // All produce the same composite key
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
  });

  it('pending session state accumulates across updates', () => {
    const pending = createPendingSession();
    const t0 = pending.startedAt;

    // Update 1: 3s in
    const { updatedData: u1 } = updatePendingSession(pending, 'playing', 3000, t0 + 3000);
    expect(u1.lastSeenAt).toBe(t0 + 3000);
    expect(u1.confirmation.maxViewOffset).toBe(3000);

    // Update 2: 6s in
    const { updatedData: u2 } = updatePendingSession(u1, 'playing', 6000, t0 + 6000);
    expect(u2.lastSeenAt).toBe(t0 + 6000);
    expect(u2.confirmation.maxViewOffset).toBe(6000);

    // Update 3: 9s in, user pauses
    const { updatedData: u3 } = updatePendingSession(u2, 'paused', 9000, t0 + 9000);
    expect(u3.lastPausedAt).toBe(t0 + 9000);
    expect(u3.pausedDurationMs).toBe(0);

    // Update 4: 15s in, user resumes (6s paused)
    const { updatedData: u4 } = updatePendingSession(u3, 'playing', 9000, t0 + 15000);
    expect(u4.lastPausedAt).toBeNull();
    expect(u4.pausedDurationMs).toBe(6000);
  });
});

// ============================================================================
// 4. Change detection: DB write vs skip
// ============================================================================

describe('change detection for DB writes', () => {
  const base = {
    state: 'playing',
    isTranscode: false,
    videoDecision: 'direct play',
    audioDecision: 'direct play',
    watched: false,
    sourceVideoCodec: 'h264',
    sourceAudioCodec: 'aac',
  };

  describe('immediate write triggers', () => {
    it('state change: playing → paused', () => {
      expect(shouldWriteToDb(base, { ...base, state: 'paused' })).toBe(true);
    });

    it('state change: paused → playing', () => {
      expect(shouldWriteToDb({ ...base, state: 'paused' }, { ...base, state: 'playing' })).toBe(
        true
      );
    });

    it('transcode starts', () => {
      expect(shouldWriteToDb(base, { ...base, isTranscode: true })).toBe(true);
    });

    it('video decision changes', () => {
      expect(shouldWriteToDb(base, { ...base, videoDecision: 'transcode' })).toBe(true);
    });

    it('audio decision changes', () => {
      expect(shouldWriteToDb(base, { ...base, audioDecision: 'copy' })).toBe(true);
    });

    it('watch completion threshold reached', () => {
      expect(shouldWriteToDb(base, base, true)).toBe(true);
    });

    it('source video codec changes', () => {
      expect(shouldWriteToDb(base, { ...base, sourceVideoCodec: 'hevc' })).toBe(true);
    });

    it('source audio codec changes', () => {
      expect(shouldWriteToDb(base, { ...base, sourceAudioCodec: 'eac3' })).toBe(true);
    });
  });

  describe('skip triggers', () => {
    it('nothing changed', () => {
      expect(shouldWriteToDb(base, { ...base })).toBe(false);
    });

    it('already watched, threshold still true', () => {
      expect(shouldWriteToDb({ ...base, watched: true }, base, true)).toBe(false);
    });
  });

  describe('flush interval', () => {
    it('DB_WRITE_FLUSH_INTERVAL_MS is 15 seconds', () => {
      expect(DB_WRITE_FLUSH_INTERVAL_MS).toBe(15_000);
    });

    it('flush interval forces write even when shouldWriteToDb is false', () => {
      const hasChanges = shouldWriteToDb(base, { ...base });
      expect(hasChanges).toBe(false);

      const sessionId = 'flush-elapsed-session';
      const now = Date.now();
      recordDbWrite(sessionId, now);
      const flushElapsed = shouldFlushDbWrite(
        sessionId,
        now + getEffectiveFlushIntervalMs(sessionId)
      );
      expect(flushElapsed).toBe(true);

      expect(hasChanges || flushElapsed).toBe(true);
    });

    it('skip write when no changes and flush interval not elapsed', () => {
      const hasChanges = shouldWriteToDb(base, { ...base });

      const sessionId = 'flush-pending-session';
      const now = Date.now();
      recordDbWrite(sessionId, now);
      const flushElapsed = shouldFlushDbWrite(sessionId, now + 5_000);

      expect(hasChanges || flushElapsed).toBe(false);
    });
  });
});

// ============================================================================
// 5. lastDbWriteMap lifecycle
// ============================================================================

describe('lastDbWriteMap lifecycle', () => {
  it('entries should be initialized to current time on session creation', () => {
    // Simulates the invariant: new Map entry on session create
    const lastDbWriteMap = new Map<string, number>();
    const sessionId = 'session-uuid-1';
    const now = Date.now();

    lastDbWriteMap.set(sessionId, now);
    expect(lastDbWriteMap.get(sessionId)).toBe(now);
  });

  it('entries should be removed on session stop', () => {
    const lastDbWriteMap = new Map<string, number>();
    lastDbWriteMap.set('session-1', Date.now());
    lastDbWriteMap.set('session-2', Date.now());

    // Stop session-1
    lastDbWriteMap.delete('session-1');
    expect(lastDbWriteMap.has('session-1')).toBe(false);
    expect(lastDbWriteMap.has('session-2')).toBe(true);
  });

  it('clear on poller stop removes all entries', () => {
    const lastDbWriteMap = new Map<string, number>();
    lastDbWriteMap.set('session-1', Date.now());
    lastDbWriteMap.set('session-2', Date.now());
    lastDbWriteMap.set('session-3', Date.now());

    lastDbWriteMap.clear();
    expect(lastDbWriteMap.size).toBe(0);
  });
});

// ============================================================================
// 6. Adaptive polling intervals
// ============================================================================

// Simulate the interval switching logic from processor.ts
function computeInterval(prevHad: boolean, nowHas: boolean, current: number): number {
  if (nowHas !== prevHad) {
    return nowHas ? 3000 : 10000;
  }
  return current;
}

describe('adaptive polling', () => {
  it('SESSIONS_ACTIVE is 3s, SESSIONS_IDLE is 10s', async () => {
    const { POLLING_INTERVALS } = await import('@tracearr/shared');
    expect(POLLING_INTERVALS.SESSIONS_ACTIVE).toBe(3000);
    expect(POLLING_INTERVALS.SESSIONS_IDLE).toBe(10000);
  });

  it('interval switching logic: idle → active when sessions appear', () => {
    const result = computeInterval(false, true, 10000);
    expect(result).toBe(3000);
  });

  it('interval switching logic: active → idle when sessions stop', () => {
    const result = computeInterval(true, false, 3000);
    expect(result).toBe(10000);
  });

  it('no switch when state unchanged', () => {
    const result = computeInterval(true, true, 3000);
    expect(result).toBe(3000); // unchanged
  });
});

// ============================================================================
// 7. Termination cooldown with composite keys
// ============================================================================

describe('termination cooldown composite keys', () => {
  it('cooldown key includes user, device, and content — not session.Id', () => {
    // A Jellyfin/Emby kill is recorded under this key: user, device and item, not session.Id
    const compositeKey1 = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'user-1',
      deviceId: 'device-1',
      ratingKey: 'movie-1',
      sessionKey: 'old-session',
    });

    const compositeKey2 = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'user-1',
      deviceId: 'device-1',
      ratingKey: 'movie-1',
      sessionKey: 'new-session-after-restart',
    });

    expect(compositeKey1).toBe(compositeKey2);
  });

  it('Plex cooldown uses session.Id — different on restart (no cooldown bypass)', () => {
    const key1 = buildCompositeKey({
      serverType: 'plex',
      serverId: 'srv-1',
      externalUserId: 'u',
      deviceId: 'd',
      ratingKey: 'r',
      sessionKey: 'plex-A',
    });

    const key2 = buildCompositeKey({
      serverType: 'plex',
      serverId: 'srv-1',
      externalUserId: 'u',
      deviceId: 'd',
      ratingKey: 'r',
      sessionKey: 'plex-B',
    });

    expect(key1).not.toBe(key2);
  });
});

// ============================================================================
// 8. Grace period with composite keys
// ============================================================================

describe('grace period with composite keys', () => {
  it('session disappearing and reappearing with same composite key is recoverable', () => {
    // Simulates the grace period tracking lifecycle:
    // 1. Session active with composite key X
    // 2. Session disappears → enters missedPollTracking with key X
    // 3. Session reappears with same composite key X (different session.Id)
    // 4. missedPollTracking.delete(X) → recovered

    const missedPollTracking = new Map<string, { id: string }>();

    const compositeKey = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'user-1',
      deviceId: 'device-1',
      ratingKey: 'movie-1',
      sessionKey: 'old-session',
    });

    // Session disappears → tracked
    missedPollTracking.set(compositeKey, { id: 'session-uuid' });
    expect(missedPollTracking.has(compositeKey)).toBe(true);

    // Session reappears with new session.Id but same composite key
    const reappearedKey = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'user-1',
      deviceId: 'device-1',
      ratingKey: 'movie-1',
      sessionKey: 'new-session', // Different session.Id!
    });

    // Same composite key → can be recovered
    expect(reappearedKey).toBe(compositeKey);
    missedPollTracking.delete(reappearedKey);
    expect(missedPollTracking.has(compositeKey)).toBe(false);
  });

  it('different content does NOT recover from grace period', () => {
    const missedPollTracking = new Map<string, { id: string }>();

    const key1 = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'user-1',
      deviceId: 'device-1',
      ratingKey: 'movie-A',
      sessionKey: 'session-1',
    });

    missedPollTracking.set(key1, { id: 'session-uuid-1' });

    const key2 = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'user-1',
      deviceId: 'device-1',
      ratingKey: 'movie-B', // Different content
      sessionKey: 'session-2',
    });

    expect(key2).not.toBe(key1);
    missedPollTracking.delete(key2); // No-op — key doesn't exist
    expect(missedPollTracking.has(key1)).toBe(true); // Original still tracked
  });
});

// ============================================================================
// 9. Regression: Jellystat #385 prevention (phantom sessions)
// ============================================================================

describe('Jellystat #385 prevention: phantom sessions from transcoding', () => {
  it('rapid play/stop cycles within 30s produce no confirmed sessions', () => {
    const t0 = 1710600000000;

    // Simulate transcoding startup: 5 rapid play/stop cycles in 10 seconds
    let pending = createPendingSession({ startedAt: t0 });
    const results: boolean[] = [];

    for (let i = 0; i < 5; i++) {
      const t = t0 + i * 2000; // Every 2 seconds

      // Play
      const { updatedData: played, isConfirmed: c1 } = updatePendingSession(
        pending,
        'playing',
        i * 1000,
        t
      );
      results.push(c1);

      // Stop (1s later) — in real code this would delete the pending session
      // but for this test we just check it's never confirmed
      const { updatedData: stopped, isConfirmed: c2 } = updatePendingSession(
        played,
        'paused',
        i * 1000,
        t + 1000
      );
      results.push(c2);
      pending = stopped;
    }

    // None of the rapid cycles should have been confirmed
    expect(results.every((r) => !r)).toBe(true);
  });
});

// ============================================================================
// 10. Regression: Jellystat #298 prevention (polling interval minimum)
// ============================================================================

describe('Jellystat #298 prevention: polling interval minimum', () => {
  it('SESSIONS_ACTIVE minimum is 3000ms (not 1000ms)', async () => {
    const { POLLING_INTERVALS } = await import('@tracearr/shared');
    expect(POLLING_INTERVALS.SESSIONS_ACTIVE).toBeGreaterThanOrEqual(3000);
  });

  it('pollerIntervalMs schema minimum is 5000ms', async () => {
    const { updateSettingsSchema } = await import('@tracearr/shared');
    const result = updateSettingsSchema.safeParse({ pollerIntervalMs: 1000 });
    expect(result.success).toBe(false);
  });

  it('pollerIntervalMs schema accepts 5000ms', async () => {
    const { updateSettingsSchema } = await import('@tracearr/shared');
    const result = updateSettingsSchema.safeParse({ pollerIntervalMs: 5000 });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// 11. Regression: Issue #597 (dashboard blackout on restart)
// ============================================================================

describe('issue #597 regression: no dashboard blackout on restart', () => {
  it('composite key ensures restart is treated as update, not new+blocked', () => {
    // The old bug: session.Id changes → old session enters grace period →
    // new session blocked by duplicate check → dashboard blank
    //
    // The fix: composite key matches → treated as existing session → no blackout
    //
    // This test validates the key invariant: same user+device+content = same key

    const activeSessionKey = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'user-uuid',
      deviceId: 'android-tv-abc',
      ratingKey: 'breaking-bad-s1e1',
      sessionKey: 'jf-session-111',
    });

    // User restarts the stream — Jellyfin assigns new session.Id
    const restartedSessionKey = buildCompositeKey({
      serverType: 'jellyfin',
      serverId: 'srv-1',
      externalUserId: 'user-uuid',
      deviceId: 'android-tv-abc',
      ratingKey: 'breaking-bad-s1e1',
      sessionKey: 'jf-session-222', // New session.Id
    });

    // The cached set would have activeSessionKey
    const cachedSessionKeys = new Set([activeSessionKey]);

    // isNew check: the restarted session matches the cached key
    const isNew = !cachedSessionKeys.has(restartedSessionKey);
    expect(isNew).toBe(false); // NOT new → goes to update path → no blackout
  });
});
