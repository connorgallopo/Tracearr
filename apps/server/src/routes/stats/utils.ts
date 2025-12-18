/**
 * Stats Route Utilities
 *
 * Shared helpers for statistics routes including date range calculation
 * and TimescaleDB aggregate availability checking.
 */

import { TIME_MS } from '@tracearr/shared';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { getTimescaleStatus } from '../../db/timescale.js';

// Cache whether aggregates are available (checked once at startup)
let aggregatesAvailable: boolean | null = null;
let hyperLogLogAvailable: boolean | null = null;

/**
 * Check if TimescaleDB continuous aggregates are available.
 * Result is cached after first check.
 */
export async function hasAggregates(): Promise<boolean> {
  if (aggregatesAvailable !== null) {
    return aggregatesAvailable;
  }
  try {
    const status = await getTimescaleStatus();
    aggregatesAvailable = status.continuousAggregates.length >= 3;
    return aggregatesAvailable;
  } catch {
    aggregatesAvailable = false;
    return false;
  }
}

/**
 * Check if TimescaleDB Toolkit (HyperLogLog) is available AND the aggregates
 * have HLL columns. This is important because:
 * 1. Extension might be installed but aggregates created without HLL
 * 2. Aggregates might exist but without HLL columns if toolkit wasn't available at migration time
 *
 * Result is cached after first check.
 */
export async function hasHyperLogLog(): Promise<boolean> {
  if (hyperLogLogAvailable !== null) {
    return hyperLogLogAvailable;
  }
  try {
    // Check both: extension installed AND aggregate has plays_hll column
    const result = await db.execute(sql`
      SELECT
        EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'timescaledb_toolkit') as extension_installed,
        EXISTS(
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'daily_stats_summary'
            AND column_name = 'plays_hll'
        ) as hll_column_exists
    `);
    const row = result.rows[0] as
      | { extension_installed: boolean; hll_column_exists: boolean }
      | undefined;
    hyperLogLogAvailable = (row?.extension_installed && row?.hll_column_exists) ?? false;
    return hyperLogLogAvailable;
  } catch {
    hyperLogLogAvailable = false;
    return false;
  }
}

/**
 * Reset cached state (useful for testing)
 */
export function resetCachedState(): void {
  aggregatesAvailable = null;
  hyperLogLogAvailable = null;
}

/**
 * Calculate start date based on period string.
 *
 * @param period - Time period: 'day', 'week', 'month', or 'year'
 * @returns Date representing the start of the period
 * @deprecated Use resolveDateRange() instead for new code
 */
export function getDateRange(period: 'day' | 'week' | 'month' | 'year'): Date {
  const now = new Date();
  switch (period) {
    case 'day':
      return new Date(now.getTime() - TIME_MS.DAY);
    case 'week':
      return new Date(now.getTime() - TIME_MS.WEEK);
    case 'month':
      return new Date(now.getTime() - 30 * TIME_MS.DAY);
    case 'year':
      return new Date(now.getTime() - 365 * TIME_MS.DAY);
  }
}

// ============================================================================
// Timezone Utilities
// ============================================================================

/**
 * Get the start of "today" in a specific timezone, returned as a UTC Date.
 *
 * For example, if it's 2024-01-15 10:00 in America/Los_Angeles (UTC-8),
 * this returns 2024-01-15 08:00 UTC (which is midnight PST).
 *
 * @param tz - IANA timezone identifier (e.g., 'America/Los_Angeles')
 * @returns Date representing midnight in the specified timezone
 */
export function getStartOfDayInTimezone(tz: string): Date {
  const now = new Date();

  // Get current date parts in target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const second = parseInt(parts.find((p) => p.type === 'second')?.value ?? '0', 10);

  // Calculate milliseconds since midnight in the target timezone
  const msSinceMidnight = (hour * 3600 + minute * 60 + second) * 1000;

  // Subtract that from now to get midnight in UTC
  return new Date(now.getTime() - msSinceMidnight);
}

// ============================================================================
// New Date Range API (supports 'all' and 'custom' periods)
// ============================================================================

export type StatsPeriod = 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';

export interface DateRange {
  /** Start date, or null for "all time" (no lower bound) */
  start: Date | null;
  /** End date (typically "now") */
  end: Date;
}

/**
 * Resolves period/custom dates into a concrete date range.
 * All queries use raw sessions table (no aggregates needed at current data volume).
 *
 * @param period - The period type
 * @param startDate - Custom start date (ISO string), required when period='custom'
 * @param endDate - Custom end date (ISO string), required when period='custom'
 * @returns DateRange with start (null for all-time) and end dates
 */
export function resolveDateRange(
  period: StatsPeriod,
  startDate?: string,
  endDate?: string
): DateRange {
  const now = new Date();

  switch (period) {
    case 'day':
      return { start: new Date(now.getTime() - TIME_MS.DAY), end: now };
    case 'week':
      return { start: new Date(now.getTime() - TIME_MS.WEEK), end: now };
    case 'month':
      return { start: new Date(now.getTime() - 30 * TIME_MS.DAY), end: now };
    case 'year':
      return { start: new Date(now.getTime() - 365 * TIME_MS.DAY), end: now };
    case 'all':
      return { start: null, end: now };
    case 'custom':
      if (!startDate || !endDate) {
        throw new Error('Custom period requires startDate and endDate');
      }
      return {
        start: new Date(startDate),
        end: new Date(endDate),
      };
  }
}

/**
 * Builds SQL WHERE clause fragment for date range filtering.
 *
 * For preset periods (day, week, month, year): WHERE started_at >= ${start}
 * For all-time (start is null): Returns empty SQL (no time filter)
 * For custom range: WHERE started_at >= ${start} AND started_at < ${end}
 *
 * @param range - DateRange from resolveDateRange()
 * @param includeEndBound - Whether to include upper bound (for custom ranges)
 * @returns SQL fragment to append to WHERE clause (includes leading AND)
 */
export function buildDateRangeFilter(range: DateRange, includeEndBound = false): SQL {
  if (!range.start) {
    // All-time: no time filter
    return sql``;
  }

  if (includeEndBound) {
    // Custom range: filter both bounds
    return sql` AND started_at >= ${range.start} AND started_at < ${range.end}`;
  }

  // Preset period: only lower bound (end is always "now")
  return sql` AND started_at >= ${range.start}`;
}
