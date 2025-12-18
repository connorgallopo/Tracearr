/**
 * Quiet Hours Service Tests
 *
 * Tests the quiet hours notification suppression:
 * - Timezone-aware time comparison
 * - Overnight quiet hour ranges
 * - Severity-based bypass
 * - Event type handling
 *
 * Uses vi.setSystemTime() to mock the current time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QuietHoursService, quietHoursService, type QuietHoursPrefs } from '../quietHours.js';

// Default prefs for testing
const DEFAULT_PREFS: QuietHoursPrefs = {
  quietHoursEnabled: true,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
  quietHoursTimezone: 'UTC',
  quietHoursOverrideCritical: true,
};

describe('QuietHoursService', () => {
  let service: QuietHoursService;

  beforeEach(() => {
    service = new QuietHoursService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isQuietTime', () => {
    it('returns false when quiet hours disabled', () => {
      const prefs: QuietHoursPrefs = {
        ...DEFAULT_PREFS,
        quietHoursEnabled: false,
      };

      // Set time to 02:00 UTC (would be in quiet hours if enabled)
      vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

      expect(service.isQuietTime(prefs)).toBe(false);
    });

    it('returns false when start time not set', () => {
      const prefs: QuietHoursPrefs = {
        ...DEFAULT_PREFS,
        quietHoursStart: null,
      };

      vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

      expect(service.isQuietTime(prefs)).toBe(false);
    });

    it('returns false when end time not set', () => {
      const prefs: QuietHoursPrefs = {
        ...DEFAULT_PREFS,
        quietHoursEnd: null,
      };

      vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

      expect(service.isQuietTime(prefs)).toBe(false);
    });

    describe('overnight quiet hours (23:00 - 07:00)', () => {
      it('returns true when time is after midnight but before end', () => {
        vi.setSystemTime(new Date('2025-01-15T03:30:00Z'));

        expect(service.isQuietTime(DEFAULT_PREFS)).toBe(true);
      });

      it('returns true when time is at start of quiet hours', () => {
        vi.setSystemTime(new Date('2025-01-15T23:00:00Z'));

        expect(service.isQuietTime(DEFAULT_PREFS)).toBe(true);
      });

      it('returns true when time is at end of quiet hours', () => {
        vi.setSystemTime(new Date('2025-01-15T07:00:00Z'));

        expect(service.isQuietTime(DEFAULT_PREFS)).toBe(true);
      });

      it('returns true when time is before midnight after start', () => {
        vi.setSystemTime(new Date('2025-01-15T23:45:00Z'));

        expect(service.isQuietTime(DEFAULT_PREFS)).toBe(true);
      });

      it('returns false when time is before start', () => {
        vi.setSystemTime(new Date('2025-01-15T22:00:00Z'));

        expect(service.isQuietTime(DEFAULT_PREFS)).toBe(false);
      });

      it('returns false when time is after end', () => {
        vi.setSystemTime(new Date('2025-01-15T10:00:00Z'));

        expect(service.isQuietTime(DEFAULT_PREFS)).toBe(false);
      });

      it('returns false at noon', () => {
        vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

        expect(service.isQuietTime(DEFAULT_PREFS)).toBe(false);
      });
    });

    describe('same-day quiet hours (01:00 - 06:00)', () => {
      const sameDayPrefs: QuietHoursPrefs = {
        ...DEFAULT_PREFS,
        quietHoursStart: '01:00',
        quietHoursEnd: '06:00',
      };

      it('returns true when time is within range', () => {
        vi.setSystemTime(new Date('2025-01-15T03:00:00Z'));

        expect(service.isQuietTime(sameDayPrefs)).toBe(true);
      });

      it('returns true at start time', () => {
        vi.setSystemTime(new Date('2025-01-15T01:00:00Z'));

        expect(service.isQuietTime(sameDayPrefs)).toBe(true);
      });

      it('returns true at end time', () => {
        vi.setSystemTime(new Date('2025-01-15T06:00:00Z'));

        expect(service.isQuietTime(sameDayPrefs)).toBe(true);
      });

      it('returns false when before range', () => {
        vi.setSystemTime(new Date('2025-01-15T00:30:00Z'));

        expect(service.isQuietTime(sameDayPrefs)).toBe(false);
      });

      it('returns false when after range', () => {
        vi.setSystemTime(new Date('2025-01-15T08:00:00Z'));

        expect(service.isQuietTime(sameDayPrefs)).toBe(false);
      });
    });

    describe('timezone handling', () => {
      it('handles America/New_York timezone correctly', () => {
        // When it's 03:00 UTC, it's 22:00 EST (previous day) in winter
        // In winter (January), EST is UTC-5
        const eastPrefs: QuietHoursPrefs = {
          ...DEFAULT_PREFS,
          quietHoursTimezone: 'America/New_York',
          quietHoursStart: '22:00', // 10 PM EST
          quietHoursEnd: '06:00', // 6 AM EST
        };

        // Set to 03:00 UTC = 22:00 EST (winter, UTC-5)
        vi.setSystemTime(new Date('2025-01-15T03:00:00Z'));

        expect(service.isQuietTime(eastPrefs)).toBe(true);
      });

      it('handles Europe/London timezone correctly', () => {
        // In January, London is UTC+0 (no DST)
        const londonPrefs: QuietHoursPrefs = {
          ...DEFAULT_PREFS,
          quietHoursTimezone: 'Europe/London',
        };

        // 02:00 UTC = 02:00 London time
        vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

        expect(service.isQuietTime(londonPrefs)).toBe(true);
      });

      it('falls back to UTC on invalid timezone', () => {
        const invalidPrefs: QuietHoursPrefs = {
          ...DEFAULT_PREFS,
          quietHoursTimezone: 'Invalid/Timezone',
        };

        // 02:00 UTC should be in quiet hours (23:00-07:00 UTC)
        vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

        // Should not throw and should use UTC
        expect(service.isQuietTime(invalidPrefs)).toBe(true);
      });
    });
  });

  describe('shouldSend', () => {
    it('returns true when not in quiet hours (any severity)', () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z')); // Noon UTC

      expect(service.shouldSend(DEFAULT_PREFS, 'low')).toBe(true);
      expect(service.shouldSend(DEFAULT_PREFS, 'warning')).toBe(true);
      expect(service.shouldSend(DEFAULT_PREFS, 'high')).toBe(true);
    });

    it('returns false for low severity during quiet hours', () => {
      vi.setSystemTime(new Date('2025-01-15T02:00:00Z')); // 2 AM UTC

      expect(service.shouldSend(DEFAULT_PREFS, 'low')).toBe(false);
    });

    it('returns false for warning severity during quiet hours', () => {
      vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

      expect(service.shouldSend(DEFAULT_PREFS, 'warning')).toBe(false);
    });

    it('returns true for high severity during quiet hours when override enabled', () => {
      vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

      expect(service.shouldSend(DEFAULT_PREFS, 'high')).toBe(true);
    });

    it('returns false for high severity during quiet hours when override disabled', () => {
      const noOverridePrefs: QuietHoursPrefs = {
        ...DEFAULT_PREFS,
        quietHoursOverrideCritical: false,
      };

      vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

      expect(service.shouldSend(noOverridePrefs, 'high')).toBe(false);
    });

    it('returns true when quiet hours disabled (all severities)', () => {
      const disabledPrefs: QuietHoursPrefs = {
        ...DEFAULT_PREFS,
        quietHoursEnabled: false,
      };

      vi.setSystemTime(new Date('2025-01-15T02:00:00Z'));

      expect(service.shouldSend(disabledPrefs, 'low')).toBe(true);
      expect(service.shouldSend(disabledPrefs, 'warning')).toBe(true);
      expect(service.shouldSend(disabledPrefs, 'high')).toBe(true);
    });
  });

  describe('shouldSendEvent', () => {
    describe('during quiet hours', () => {
      beforeEach(() => {
        vi.setSystemTime(new Date('2025-01-15T02:00:00Z')); // 2 AM UTC
      });

      it('treats server_down as high severity (allows with override)', () => {
        expect(service.shouldSendEvent(DEFAULT_PREFS, 'server_down')).toBe(true);
      });

      it('treats server_down as high severity (blocks without override)', () => {
        const noOverridePrefs: QuietHoursPrefs = {
          ...DEFAULT_PREFS,
          quietHoursOverrideCritical: false,
        };

        expect(service.shouldSendEvent(noOverridePrefs, 'server_down')).toBe(false);
      });

      it('treats session_started as low severity (blocks)', () => {
        expect(service.shouldSendEvent(DEFAULT_PREFS, 'session_started')).toBe(false);
      });

      it('treats session_stopped as low severity (blocks)', () => {
        expect(service.shouldSendEvent(DEFAULT_PREFS, 'session_stopped')).toBe(false);
      });

      it('treats server_up as low severity (blocks)', () => {
        expect(service.shouldSendEvent(DEFAULT_PREFS, 'server_up')).toBe(false);
      });
    });

    describe('outside quiet hours', () => {
      beforeEach(() => {
        vi.setSystemTime(new Date('2025-01-15T12:00:00Z')); // Noon UTC
      });

      it('allows all event types', () => {
        expect(service.shouldSendEvent(DEFAULT_PREFS, 'session_started')).toBe(true);
        expect(service.shouldSendEvent(DEFAULT_PREFS, 'session_stopped')).toBe(true);
        expect(service.shouldSendEvent(DEFAULT_PREFS, 'server_down')).toBe(true);
        expect(service.shouldSendEvent(DEFAULT_PREFS, 'server_up')).toBe(true);
      });
    });
  });

  describe('singleton instance', () => {
    it('quietHoursService is an instance of QuietHoursService', () => {
      expect(quietHoursService).toBeInstanceOf(QuietHoursService);
    });
  });
});
