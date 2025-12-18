/**
 * State Tracker Tests
 *
 * Tests session state tracking functions from poller/stateTracker.ts:
 * - calculatePauseAccumulation: Track pause duration across state transitions
 * - calculateStopDuration: Calculate final watch time when session stops
 * - checkWatchCompletion: Determine if content was "watched" (80% threshold)
 * - shouldGroupWithPreviousSession: Link resumed sessions together
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  calculatePauseAccumulation,
  calculateStopDuration,
  checkWatchCompletion,
  isQualityChangeScenario,
  shouldGroupWithPreviousSession,
} from '../stateTracker.js';

describe('calculatePauseAccumulation', () => {
  describe('state transitions', () => {
    it('should record lastPausedAt when transitioning from playing to paused', () => {
      const now = new Date();
      const result = calculatePauseAccumulation(
        'playing',
        'paused',
        { lastPausedAt: null, pausedDurationMs: 0 },
        now
      );

      expect(result.lastPausedAt).toEqual(now);
      expect(result.pausedDurationMs).toBe(0);
    });

    it('should accumulate pause duration when transitioning from paused to playing', () => {
      const pauseStart = new Date('2024-01-01T10:00:00Z');
      const resumeTime = new Date('2024-01-01T10:30:00Z'); // 30 minutes later

      const result = calculatePauseAccumulation(
        'paused',
        'playing',
        { lastPausedAt: pauseStart, pausedDurationMs: 0 },
        resumeTime
      );

      expect(result.lastPausedAt).toBeNull();
      expect(result.pausedDurationMs).toBe(30 * 60 * 1000);
    });

    it('should not change anything for playing to playing transition', () => {
      const now = new Date();
      const existingSession = { lastPausedAt: null, pausedDurationMs: 5000 };

      const result = calculatePauseAccumulation('playing', 'playing', existingSession, now);

      expect(result.lastPausedAt).toBeNull();
      expect(result.pausedDurationMs).toBe(5000);
    });

    it('should not change anything for paused to paused transition', () => {
      const pausedAt = new Date('2024-01-01T10:00:00Z');
      const now = new Date('2024-01-01T10:30:00Z');
      const existingSession = { lastPausedAt: pausedAt, pausedDurationMs: 5000 };

      const result = calculatePauseAccumulation('paused', 'paused', existingSession, now);

      expect(result.lastPausedAt).toEqual(pausedAt);
      expect(result.pausedDurationMs).toBe(5000);
    });
  });

  describe('multiple pause cycles', () => {
    it('should accumulate correctly across multiple pause/resume cycles', () => {
      const times = {
        pause1: new Date('2024-01-01T10:05:00Z'),
        resume1: new Date('2024-01-01T10:10:00Z'), // 5 min pause
        pause2: new Date('2024-01-01T10:15:00Z'),
        resume2: new Date('2024-01-01T10:25:00Z'), // 10 min pause
      };

      let session = { lastPausedAt: null as Date | null, pausedDurationMs: 0 };

      // First pause
      session = calculatePauseAccumulation('playing', 'paused', session, times.pause1);
      expect(session.lastPausedAt).toEqual(times.pause1);

      // First resume - 5 min accumulated
      session = calculatePauseAccumulation('paused', 'playing', session, times.resume1);
      expect(session.pausedDurationMs).toBe(5 * 60 * 1000);

      // Second pause
      session = calculatePauseAccumulation('playing', 'paused', session, times.pause2);
      expect(session.lastPausedAt).toEqual(times.pause2);

      // Second resume - 15 min total (5 + 10)
      session = calculatePauseAccumulation('paused', 'playing', session, times.resume2);
      expect(session.pausedDurationMs).toBe(15 * 60 * 1000);
      expect(session.lastPausedAt).toBeNull();
    });
  });
});

describe('calculateStopDuration', () => {
  describe('basic duration calculation', () => {
    it('should calculate correct duration for session with no pauses', () => {
      const startedAt = new Date('2024-01-01T10:00:00Z');
      const stoppedAt = new Date('2024-01-01T12:00:00Z'); // 2 hours later

      const result = calculateStopDuration(
        { startedAt, lastPausedAt: null, pausedDurationMs: 0 },
        stoppedAt
      );

      expect(result.durationMs).toBe(2 * 60 * 60 * 1000);
      expect(result.finalPausedDurationMs).toBe(0);
    });

    it('should exclude accumulated pause time from duration', () => {
      const startedAt = new Date('2024-01-01T10:00:00Z');
      const stoppedAt = new Date('2024-01-01T12:00:00Z');

      const result = calculateStopDuration(
        {
          startedAt,
          lastPausedAt: null,
          pausedDurationMs: 30 * 60 * 1000, // 30 minutes paused
        },
        stoppedAt
      );

      expect(result.durationMs).toBe(1.5 * 60 * 60 * 1000);
      expect(result.finalPausedDurationMs).toBe(30 * 60 * 1000);
    });
  });

  describe('stopped while paused', () => {
    it('should include remaining pause time if stopped while paused', () => {
      const startedAt = new Date('2024-01-01T10:00:00Z');
      const pausedAt = new Date('2024-01-01T11:30:00Z');
      const stoppedAt = new Date('2024-01-01T12:00:00Z');

      const result = calculateStopDuration(
        {
          startedAt,
          lastPausedAt: pausedAt,
          pausedDurationMs: 15 * 60 * 1000, // 15 minutes already accumulated
        },
        stoppedAt
      );

      // Total elapsed: 2 hours
      // Paused: 15 min (previous) + 30 min (current) = 45 min
      // Watch time: 2 hours - 45 min = 1.25 hours
      expect(result.finalPausedDurationMs).toBe(45 * 60 * 1000);
      expect(result.durationMs).toBe(1.25 * 60 * 60 * 1000);
    });
  });

  describe('edge cases', () => {
    it('should not return negative duration', () => {
      const startedAt = new Date('2024-01-01T10:00:00Z');
      const stoppedAt = new Date('2024-01-01T10:30:00Z');

      const result = calculateStopDuration(
        {
          startedAt,
          lastPausedAt: null,
          pausedDurationMs: 60 * 60 * 1000, // More than elapsed
        },
        stoppedAt
      );

      expect(result.durationMs).toBe(0);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle movie with dinner break', () => {
      const startedAt = new Date('2024-01-01T18:00:00Z');
      const stoppedAt = new Date('2024-01-01T21:00:00Z'); // 3 hours wall clock

      const result = calculateStopDuration(
        {
          startedAt,
          lastPausedAt: null,
          pausedDurationMs: 60 * 60 * 1000, // 1 hour dinner pause
        },
        stoppedAt
      );

      expect(result.durationMs).toBe(2 * 60 * 60 * 1000);
    });
  });
});

describe('checkWatchCompletion', () => {
  describe('85% threshold (industry standard)', () => {
    it('should return true when progress >= 85%', () => {
      expect(checkWatchCompletion(8500, 10000)).toBe(true); // Exactly 85%
      expect(checkWatchCompletion(9000, 10000)).toBe(true); // 90%
      expect(checkWatchCompletion(10000, 10000)).toBe(true); // 100%
    });

    it('should return false when progress < 85%', () => {
      expect(checkWatchCompletion(8499, 10000)).toBe(false); // Just under 85%
      expect(checkWatchCompletion(8000, 10000)).toBe(false); // 80%
      expect(checkWatchCompletion(5000, 10000)).toBe(false); // 50%
    });
  });

  describe('null handling', () => {
    it('should return false when progressMs is null', () => {
      expect(checkWatchCompletion(null, 10000)).toBe(false);
    });

    it('should return false when totalDurationMs is null', () => {
      expect(checkWatchCompletion(8000, null)).toBe(false);
    });

    it('should return false when both are null', () => {
      expect(checkWatchCompletion(null, null)).toBe(false);
    });
  });
});

describe('shouldGroupWithPreviousSession', () => {
  describe('session grouping', () => {
    it('should group when resuming from same progress within threshold', () => {
      const previousSessionId = randomUUID();
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);

      const result = shouldGroupWithPreviousSession(
        {
          id: previousSessionId,
          referenceId: null,
          progressMs: 30 * 60 * 1000,
          watched: false,
          stoppedAt: thirtySecondsAgo,
        },
        30 * 60 * 1000
      );

      expect(result).toBe(previousSessionId);
    });

    it('should use existing referenceId for chained sessions', () => {
      const originalSessionId = randomUUID();
      const previousSessionId = randomUUID();
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);

      const result = shouldGroupWithPreviousSession(
        {
          id: previousSessionId,
          referenceId: originalSessionId,
          progressMs: 60 * 60 * 1000,
          watched: false,
          stoppedAt: thirtySecondsAgo,
        },
        60 * 60 * 1000
      );

      expect(result).toBe(originalSessionId);
    });
  });

  describe('no grouping conditions', () => {
    it('should not group if previous session was fully watched', () => {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);

      const result = shouldGroupWithPreviousSession(
        {
          id: randomUUID(),
          referenceId: null,
          progressMs: 90 * 60 * 1000,
          watched: true,
          stoppedAt: thirtySecondsAgo,
        },
        0
      );

      expect(result).toBeNull();
    });

    it('should not group if previous session is older than 24 hours', () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

      const result = shouldGroupWithPreviousSession(
        {
          id: randomUUID(),
          referenceId: null,
          progressMs: 30 * 60 * 1000,
          watched: false,
          stoppedAt: twoDaysAgo,
        },
        30 * 60 * 1000
      );

      expect(result).toBeNull();
    });

    it('should not group if user rewound (new progress < previous)', () => {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);

      const result = shouldGroupWithPreviousSession(
        {
          id: randomUUID(),
          referenceId: null,
          progressMs: 60 * 60 * 1000,
          watched: false,
          stoppedAt: thirtySecondsAgo,
        },
        30 * 60 * 1000 // Rewound
      );

      expect(result).toBeNull();
    });

    it('should not group if gap exceeds default threshold (60s)', () => {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

      const result = shouldGroupWithPreviousSession(
        {
          id: randomUUID(),
          referenceId: null,
          progressMs: 30 * 60 * 1000,
          watched: false,
          stoppedAt: twoMinutesAgo,
        },
        30 * 60 * 1000
      );

      expect(result).toBeNull();
    });
  });
});

describe('Integration: Complete Watch Session', () => {
  it('should handle complete watch session with multiple pauses', () => {
    const times = {
      start: new Date('2024-01-01T10:00:00Z'),
      pause1: new Date('2024-01-01T10:30:00Z'),
      resume1: new Date('2024-01-01T10:45:00Z'), // 15 min pause
      pause2: new Date('2024-01-01T11:30:00Z'),
      resume2: new Date('2024-01-01T12:00:00Z'), // 30 min pause
      stop: new Date('2024-01-01T12:45:00Z'),
    };

    let session = { lastPausedAt: null as Date | null, pausedDurationMs: 0 };

    session = calculatePauseAccumulation('playing', 'paused', session, times.pause1);
    session = calculatePauseAccumulation('paused', 'playing', session, times.resume1);
    session = calculatePauseAccumulation('playing', 'paused', session, times.pause2);
    session = calculatePauseAccumulation('paused', 'playing', session, times.resume2);

    expect(session.pausedDurationMs).toBe(45 * 60 * 1000);

    const result = calculateStopDuration({ startedAt: times.start, ...session }, times.stop);

    // Wall clock: 2h 45m, Paused: 45m, Watch time: 2h
    expect(result.durationMs).toBe(120 * 60 * 1000);
  });

  it('should correctly chain session groups', () => {
    const session1Id = randomUUID();
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);

    // First resume - links to session1
    const ref1 = shouldGroupWithPreviousSession(
      {
        id: session1Id,
        referenceId: null,
        progressMs: 30 * 60 * 1000,
        watched: false,
        stoppedAt: thirtySecondsAgo,
      },
      30 * 60 * 1000
    );
    expect(ref1).toBe(session1Id);

    // Second resume - should still link to original
    const session2Id = randomUUID();
    const ref2 = shouldGroupWithPreviousSession(
      {
        id: session2Id,
        referenceId: session1Id,
        progressMs: 60 * 60 * 1000,
        watched: false,
        stoppedAt: thirtySecondsAgo,
      },
      60 * 60 * 1000
    );
    expect(ref2).toBe(session1Id);
  });
});

describe('isQualityChangeScenario', () => {
  describe('quality change detection', () => {
    it('should return session id when active session exists for same user+content', () => {
      const sessionId = randomUUID();

      const result = isQualityChangeScenario({
        id: sessionId,
        referenceId: null,
        stoppedAt: null, // Active session
      });

      expect(result).toBe(sessionId);
    });

    it('should return original referenceId when session is already part of a chain', () => {
      const originalSessionId = randomUUID();
      const currentSessionId = randomUUID();

      const result = isQualityChangeScenario({
        id: currentSessionId,
        referenceId: originalSessionId, // Already linked to original
        stoppedAt: null,
      });

      expect(result).toBe(originalSessionId);
    });
  });

  describe('non-quality-change scenarios', () => {
    it('should return null when no existing session', () => {
      expect(isQualityChangeScenario(null)).toBeNull();
      expect(isQualityChangeScenario(undefined)).toBeNull();
    });

    it('should return null when session is already stopped (resume scenario)', () => {
      const result = isQualityChangeScenario({
        id: randomUUID(),
        referenceId: null,
        stoppedAt: new Date(), // Session stopped - not a quality change
      });

      expect(result).toBeNull();
    });

    it('should return null for stopped session even with referenceId', () => {
      const result = isQualityChangeScenario({
        id: randomUUID(),
        referenceId: randomUUID(),
        stoppedAt: new Date(), // Session stopped
      });

      expect(result).toBeNull();
    });
  });
});
