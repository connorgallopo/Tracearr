/**
 * Stats Route Utilities Tests
 *
 * Tests pure utility functions from routes/stats/utils.ts:
 * - resolveDateRange: Calculate date range based on period and optional custom dates
 * - getDateRange: (deprecated) Calculate start date based on period string
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-deprecated
import {
  getDateRange,
  resolveDateRange,
  buildDateRangeFilter,
  resetCachedState,
  hasAggregates,
  hasHyperLogLog,
  getStartOfDayInTimezone,
} from '../utils.js';

// Mock the database module
vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

vi.mock('../../../db/timescale.js', () => ({
  getTimescaleStatus: vi.fn(),
}));

describe('resolveDateRange', () => {
  beforeEach(() => {
    // Fix time to 2024-06-15 12:00:00 UTC for predictable tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('preset periods', () => {
    it('should return start 1 day ago for "day" period', () => {
      const result = resolveDateRange('day');
      expect(result.start).toEqual(new Date('2024-06-14T12:00:00Z'));
      expect(result.end).toEqual(new Date('2024-06-15T12:00:00Z'));
    });

    it('should return start 7 days ago for "week" period', () => {
      const result = resolveDateRange('week');
      expect(result.start).toEqual(new Date('2024-06-08T12:00:00Z'));
      expect(result.end).toEqual(new Date('2024-06-15T12:00:00Z'));
    });

    it('should return start 30 days ago for "month" period', () => {
      const result = resolveDateRange('month');
      expect(result.start).toEqual(new Date('2024-05-16T12:00:00Z'));
      expect(result.end).toEqual(new Date('2024-06-15T12:00:00Z'));
    });

    it('should return start 365 days ago for "year" period', () => {
      const result = resolveDateRange('year');
      expect(result.start).toEqual(new Date('2023-06-16T12:00:00Z'));
      expect(result.end).toEqual(new Date('2024-06-15T12:00:00Z'));
    });
  });

  describe('all-time period', () => {
    it('should return null start for "all" period', () => {
      const result = resolveDateRange('all');
      expect(result.start).toBeNull();
      expect(result.end).toEqual(new Date('2024-06-15T12:00:00Z'));
    });
  });

  describe('custom period', () => {
    it('should use provided start and end dates', () => {
      const result = resolveDateRange('custom', '2024-01-01T00:00:00Z', '2024-01-31T23:59:59Z');
      expect(result.start).toEqual(new Date('2024-01-01T00:00:00Z'));
      expect(result.end).toEqual(new Date('2024-01-31T23:59:59Z'));
    });

    it('should throw if custom period missing startDate', () => {
      expect(() => resolveDateRange('custom', undefined, '2024-01-31T00:00:00Z')).toThrow(
        'Custom period requires startDate and endDate'
      );
    });

    it('should throw if custom period missing endDate', () => {
      expect(() => resolveDateRange('custom', '2024-01-01T00:00:00Z', undefined)).toThrow(
        'Custom period requires startDate and endDate'
      );
    });
  });
});

// Tests for deprecated getDateRange (kept for backwards compatibility)
/* eslint-disable @typescript-eslint/no-deprecated */
describe('getDateRange (deprecated)', () => {
  beforeEach(() => {
    // Fix time to 2024-06-15 12:00:00 UTC for predictable tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('period calculations', () => {
    it('should return date 1 day ago for "day" period', () => {
      const result = getDateRange('day');
      expect(result).toEqual(new Date('2024-06-14T12:00:00Z'));
    });

    it('should return date 7 days ago for "week" period', () => {
      const result = getDateRange('week');
      expect(result).toEqual(new Date('2024-06-08T12:00:00Z'));
    });

    it('should return date 30 days ago for "month" period', () => {
      const result = getDateRange('month');
      expect(result).toEqual(new Date('2024-05-16T12:00:00Z'));
    });

    it('should return date 365 days ago for "year" period', () => {
      const result = getDateRange('year');
      expect(result).toEqual(new Date('2023-06-16T12:00:00Z'));
    });
  });

  describe('return type', () => {
    it('should return a Date object', () => {
      const result = getDateRange('day');
      expect(result).toBeInstanceOf(Date);
    });
  });

  describe('relative time correctness', () => {
    it('should calculate milliseconds correctly for day', () => {
      const now = new Date('2024-06-15T12:00:00Z');
      const result = getDateRange('day');
      const diffMs = now.getTime() - result.getTime();
      expect(diffMs).toBe(24 * 60 * 60 * 1000); // 1 day in ms
    });

    it('should calculate milliseconds correctly for week', () => {
      const now = new Date('2024-06-15T12:00:00Z');
      const result = getDateRange('week');
      const diffMs = now.getTime() - result.getTime();
      expect(diffMs).toBe(7 * 24 * 60 * 60 * 1000); // 7 days in ms
    });

    it('should calculate milliseconds correctly for month', () => {
      const now = new Date('2024-06-15T12:00:00Z');
      const result = getDateRange('month');
      const diffMs = now.getTime() - result.getTime();
      expect(diffMs).toBe(30 * 24 * 60 * 60 * 1000); // 30 days in ms
    });

    it('should calculate milliseconds correctly for year', () => {
      const now = new Date('2024-06-15T12:00:00Z');
      const result = getDateRange('year');
      const diffMs = now.getTime() - result.getTime();
      expect(diffMs).toBe(365 * 24 * 60 * 60 * 1000); // 365 days in ms
    });
  });
});
/* eslint-enable @typescript-eslint/no-deprecated */

describe('buildDateRangeFilter', () => {
  // Helper to extract SQL string parts from drizzle sql template result
  // Drizzle uses StringChunk objects with value arrays for string parts
  const getSqlStrings = (sqlResult: ReturnType<typeof buildDateRangeFilter>) => {
    return sqlResult.queryChunks
      .map((chunk) => {
        // StringChunk has { value: string[] }
        if (chunk && typeof chunk === 'object' && 'value' in chunk) {
          return (chunk as { value: string[] }).value.join('');
        }
        return '';
      })
      .join('');
  };

  it('should return empty SQL for null start (all-time)', () => {
    const range = { start: null, end: new Date('2024-06-15T12:00:00Z') };
    const result = buildDateRangeFilter(range);
    const sqlStrings = getSqlStrings(result);
    expect(sqlStrings.trim()).toBe('');
  });

  it('should return lower bound only for preset periods', () => {
    const start = new Date('2024-06-14T12:00:00Z');
    const end = new Date('2024-06-15T12:00:00Z');
    const range = { start, end };
    const result = buildDateRangeFilter(range);
    const sqlStrings = getSqlStrings(result);
    expect(sqlStrings).toContain('AND started_at >=');
    expect(sqlStrings).not.toContain('AND started_at <');
  });

  it('should return both bounds when includeEndBound is true', () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date('2024-01-31T23:59:59Z');
    const range = { start, end };
    const result = buildDateRangeFilter(range, true);
    const sqlStrings = getSqlStrings(result);
    expect(sqlStrings).toContain('AND started_at >=');
    expect(sqlStrings).toContain('AND started_at <');
  });

  it('should work with resolveDateRange output for week', () => {
    const range = resolveDateRange('week');
    const result = buildDateRangeFilter(range);
    const sqlStrings = getSqlStrings(result);
    expect(sqlStrings).toContain('AND started_at >=');
  });

  it('should work with all-time from resolveDateRange', () => {
    const range = resolveDateRange('all');
    const result = buildDateRangeFilter(range);
    const sqlStrings = getSqlStrings(result);
    expect(sqlStrings.trim()).toBe('');
  });
});

describe('resetCachedState', () => {
  it('should reset cached state without error', () => {
    // This function resets internal cache variables - just verify it runs
    expect(() => resetCachedState()).not.toThrow();
  });

  it('should be callable multiple times', () => {
    // Should be safe to call multiple times
    resetCachedState();
    resetCachedState();
    expect(() => resetCachedState()).not.toThrow();
  });
});

describe('hasAggregates', () => {
  beforeEach(() => {
    resetCachedState();
    vi.clearAllMocks();
  });

  it('should return true when 3+ aggregates exist', async () => {
    const { getTimescaleStatus } = await import('../../../db/timescale.js');
    vi.mocked(getTimescaleStatus).mockResolvedValueOnce({
      extensionInstalled: true,
      sessionsIsHypertable: true,
      compressionEnabled: false,
      continuousAggregates: ['agg1', 'agg2', 'agg3'],
      chunkCount: 0,
    });
    const result = await hasAggregates();
    expect(result).toBe(true);
  });

  it('should return false when fewer than 3 aggregates', async () => {
    const { getTimescaleStatus } = await import('../../../db/timescale.js');
    vi.mocked(getTimescaleStatus).mockResolvedValueOnce({
      extensionInstalled: true,
      sessionsIsHypertable: true,
      compressionEnabled: false,
      continuousAggregates: ['agg1'],
      chunkCount: 0,
    });
    const result = await hasAggregates();
    expect(result).toBe(false);
  });

  it('should return false on error', async () => {
    const { getTimescaleStatus } = await import('../../../db/timescale.js');
    vi.mocked(getTimescaleStatus).mockRejectedValueOnce(new Error('DB error'));
    const result = await hasAggregates();
    expect(result).toBe(false);
  });

  it('should cache the result', async () => {
    const { getTimescaleStatus } = await import('../../../db/timescale.js');
    vi.mocked(getTimescaleStatus).mockResolvedValueOnce({
      extensionInstalled: true,
      sessionsIsHypertable: true,
      compressionEnabled: false,
      continuousAggregates: ['agg1', 'agg2', 'agg3'],
      chunkCount: 0,
    });
    await hasAggregates();
    await hasAggregates();
    // Should only call getTimescaleStatus once due to caching
    expect(getTimescaleStatus).toHaveBeenCalledTimes(1);
  });
});

describe('hasHyperLogLog', () => {
  beforeEach(() => {
    resetCachedState();
    vi.clearAllMocks();
  });

  it('should return true when extension and column exist', async () => {
    const { db } = await import('../../../db/client.js');
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [{ extension_installed: true, hll_column_exists: true }],
    } as never);
    const result = await hasHyperLogLog();
    expect(result).toBe(true);
  });

  it('should return false when extension missing', async () => {
    const { db } = await import('../../../db/client.js');
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [{ extension_installed: false, hll_column_exists: true }],
    } as never);
    const result = await hasHyperLogLog();
    expect(result).toBe(false);
  });

  it('should return false when column missing', async () => {
    const { db } = await import('../../../db/client.js');
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [{ extension_installed: true, hll_column_exists: false }],
    } as never);
    const result = await hasHyperLogLog();
    expect(result).toBe(false);
  });

  it('should return false on error', async () => {
    const { db } = await import('../../../db/client.js');
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('DB error'));
    const result = await hasHyperLogLog();
    expect(result).toBe(false);
  });

  it('should cache the result', async () => {
    const { db } = await import('../../../db/client.js');
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [{ extension_installed: true, hll_column_exists: true }],
    } as never);
    await hasHyperLogLog();
    await hasHyperLogLog();
    // Should only call db.execute once due to caching
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

describe('getStartOfDayInTimezone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return midnight UTC for UTC timezone', () => {
    // Set time to 2024-06-15 14:30:00 UTC
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));
    const result = getStartOfDayInTimezone('UTC');
    expect(result).toEqual(new Date('2024-06-15T00:00:00Z'));
  });

  it('should return UTC time for midnight in America/Los_Angeles (PST, UTC-8)', () => {
    // Set time to 2024-01-15 10:00 PST (18:00 UTC)
    // Winter time so PST is UTC-8
    vi.setSystemTime(new Date('2024-01-15T18:00:00Z'));
    const result = getStartOfDayInTimezone('America/Los_Angeles');
    // Midnight PST = 08:00 UTC
    expect(result).toEqual(new Date('2024-01-15T08:00:00Z'));
  });

  it('should return UTC time for midnight in America/Los_Angeles (PDT, UTC-7)', () => {
    // Set time to 2024-06-15 10:00 PDT (17:00 UTC)
    // Summer time so PDT is UTC-7
    vi.setSystemTime(new Date('2024-06-15T17:00:00Z'));
    const result = getStartOfDayInTimezone('America/Los_Angeles');
    // Midnight PDT = 07:00 UTC
    expect(result).toEqual(new Date('2024-06-15T07:00:00Z'));
  });

  it('should return UTC time for midnight in Europe/London (BST, UTC+1)', () => {
    // Set time to 2024-06-15 14:00 BST (13:00 UTC)
    // Summer time so BST is UTC+1
    vi.setSystemTime(new Date('2024-06-15T13:00:00Z'));
    const result = getStartOfDayInTimezone('Europe/London');
    // Midnight BST = 23:00 UTC (previous day)
    expect(result).toEqual(new Date('2024-06-14T23:00:00Z'));
  });

  it('should return UTC time for midnight in Europe/London (GMT, UTC+0)', () => {
    // Set time to 2024-01-15 14:00 GMT (14:00 UTC)
    // Winter time so GMT is UTC+0
    vi.setSystemTime(new Date('2024-01-15T14:00:00Z'));
    const result = getStartOfDayInTimezone('Europe/London');
    // Midnight GMT = 00:00 UTC
    expect(result).toEqual(new Date('2024-01-15T00:00:00Z'));
  });

  it('should return UTC time for midnight in Asia/Tokyo (UTC+9)', () => {
    // Set time to 2024-06-15 22:00 JST (13:00 UTC)
    vi.setSystemTime(new Date('2024-06-15T13:00:00Z'));
    const result = getStartOfDayInTimezone('Asia/Tokyo');
    // Midnight JST = 15:00 UTC (previous day)
    expect(result).toEqual(new Date('2024-06-14T15:00:00Z'));
  });

  it('should handle timezone with 30-minute offset (Asia/Kolkata, UTC+5:30)', () => {
    // Set time to 2024-06-15 14:30 IST (09:00 UTC)
    vi.setSystemTime(new Date('2024-06-15T09:00:00Z'));
    const result = getStartOfDayInTimezone('Asia/Kolkata');
    // Midnight IST = 18:30 UTC (previous day)
    expect(result).toEqual(new Date('2024-06-14T18:30:00Z'));
  });

  it('should handle date boundary crossing correctly', () => {
    // When it's early morning in UTC, it might still be "yesterday" in western timezones
    // 2024-06-15 02:00 UTC
    vi.setSystemTime(new Date('2024-06-15T02:00:00Z'));
    const result = getStartOfDayInTimezone('America/Los_Angeles');
    // At 02:00 UTC, it's 19:00 PDT on June 14
    // So "today" start in LA is June 14 00:00 PDT = June 14 07:00 UTC
    expect(result).toEqual(new Date('2024-06-14T07:00:00Z'));
  });

  it('should return a valid Date object', () => {
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));
    const result = getStartOfDayInTimezone('America/New_York');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).not.toBeNaN();
  });
});
