/**
 * Shared formatting utilities for dates, durations, bytes, and numbers.
 * Centralizes duplicated logic from multiple components.
 */
import { formatDistanceToNow, format } from 'date-fns';
import { getTimeFormatString, getDateTimeFormatString } from '@/lib/timeFormat';

/**
 * Safely parse a date that might be a Date object, string, null, or undefined.
 * Returns null for invalid dates.
 */
export function safeParseDate(date: Date | string | null | undefined): Date | null {
  if (!date) return null;
  const parsed = new Date(date);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Safely format a date with a format string.
 * Returns fallback string for invalid dates.
 */
export function safeFormatDate(
  date: Date | string | null | undefined,
  formatStr: string,
  fallback = 'Unknown'
): string {
  const parsed = safeParseDate(date);
  if (!parsed) return fallback;
  return format(parsed, formatStr);
}

/**
 * Safely format distance to now with suffix.
 * Returns fallback string for invalid dates.
 */
export function safeFormatDistanceToNow(
  date: Date | string | null | undefined,
  fallback = 'Unknown'
): string {
  const parsed = safeParseDate(date);
  if (!parsed) return fallback;
  return formatDistanceToNow(parsed, { addSuffix: true });
}

/**
 * Format duration in milliseconds to human-readable string.
 * Supports multiple output formats.
 *
 * @param ms - Duration in milliseconds
 * @param options.style - Output format:
 *   - 'clock': HH:MM:SS or MM:SS format (e.g., "1:30:45" or "30:45")
 *   - 'compact': Short format with seconds for small values (e.g., "2h 30m", "5m 30s", "45s")
 *   - 'compactShort': Short format without seconds (e.g., "2h 30m", "45m", "<1m")
 *   - 'full': Long format (e.g., "2 hours 30 minutes")
 * @param options.emptyValue - Custom empty value (default: '--:--' for clock, '—' for others)
 */
export function formatDuration(
  ms: number | null | undefined,
  options: {
    style?: 'compact' | 'compactShort' | 'compactDays' | 'full' | 'clock';
    emptyValue?: string;
  } = {}
): string {
  const { style = 'clock', emptyValue } = options;

  if (ms === null || ms === undefined || ms === 0) {
    if (emptyValue !== undefined) return emptyValue;
    return style === 'clock' ? '--:--' : '—';
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const days = Math.floor(hours / 24);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  switch (style) {
    case 'clock':
      // HH:MM:SS or MM:SS format
      if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      }
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;

    case 'full': {
      // "2 hours 30 minutes" format
      const parts: string[] = [];
      if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
      if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
      if (parts.length === 0) return '<1 minute';
      return parts.join(' ');
    }

    case 'compact':
      // "2h 30m" or "5m 30s" or "45s" format (includes seconds for smaller values)
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m ${seconds}s`;
      return `${seconds}s`;

    case 'compactDays': {
      // Two largest units only: spans here run to months, where "4909h 1m" is unreadable.
      if (days > 0) {
        const restHours = hours % 24;
        return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
      }
      if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
      return minutes > 0 ? `${minutes}m` : '<1m';
    }

    case 'compactShort':
    default:
      // "2h 30m" format (no seconds)
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m`;
      return '<1m';
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Format bytes to human-readable string.
 * Supports numeric, BigInt string inputs (from database), and direct number values.
 *
 * @param bytes - Byte count (number, BigInt as string, or numeric string)
 * @param decimals - Decimal places for display (default: 1)
 * @param options.emptyValue - Custom empty value (default: '0 B')
 * @param options.minUnit - Minimum unit to display (e.g., 'GB' to skip B/KB/MB)
 */
export function formatBytes(
  bytes: number | string | null | undefined,
  decimals = 1,
  options: { emptyValue?: string; minUnit?: (typeof BYTE_UNITS)[number] } = {}
): string {
  const { emptyValue = '0 B', minUnit } = options;

  if (bytes === null || bytes === undefined) return emptyValue;

  // Handle BigInt strings from database (common for storage totals)
  let numBytes: number;
  if (typeof bytes === 'string') {
    // Try BigInt first for very large values, fall back to parseFloat
    try {
      numBytes = Number(BigInt(bytes));
    } catch {
      numBytes = parseFloat(bytes);
    }
  } else {
    numBytes = bytes;
  }

  if (isNaN(numBytes) || numBytes === 0) return emptyValue;

  const k = 1024;
  let i = Math.floor(Math.log(numBytes) / Math.log(k));
  i = Math.min(i, BYTE_UNITS.length - 1);

  // Apply minimum unit if specified
  if (minUnit) {
    const minIndex = BYTE_UNITS.indexOf(minUnit);
    if (minIndex > i) {
      i = minIndex;
    }
  }

  const value = numBytes / Math.pow(k, i);

  return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${BYTE_UNITS[i]}`;
}

/**
 * Format a timestamp for display in lists.
 * Shows "Today 2:30 PM", "Yesterday 9:15 AM", or "Jan 12, 2:30 PM".
 */
export function formatListTimestamp(date: Date | string | null | undefined): string {
  const parsed = safeParseDate(date);
  if (!parsed) return '-';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dateOnly = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const timeStr = format(parsed, getTimeFormatString());

  if (dateOnly.getTime() === today.getTime()) {
    return `Today ${timeStr}`;
  }
  if (dateOnly.getTime() === yesterday.getTime()) {
    return `Yesterday ${timeStr}`;
  }
  return format(parsed, getDateTimeFormatString());
}

/**
 * Format a number with locale-aware thousands separators.
 */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return value.toLocaleString();
}

/**
 * Format a percentage value.
 *
 * @param value - Percentage value (0-100 or 0-1 depending on isDecimal)
 * @param decimals - Decimal places to display
 * @param isDecimal - If true, value is 0-1; if false, value is 0-100
 */
export function formatPercent(
  value: number | null | undefined,
  decimals = 1,
  isDecimal = false
): string {
  if (value === null || value === undefined) return '-';
  const percent = isDecimal ? value * 100 : value;
  return `${percent.toFixed(decimals)}%`;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Compact relative age for library-freshness UI: "14h", "3d", "15w", "11mo",
 * "2y". Plain elapsed-time math rather than date-fns calendar helpers, so
 * results don't shift with local midnight/week-start boundaries. Shared by
 * the poster card meta line and the hover tile so both read off one clock.
 */
export function formatCompactAge(dateStr: string | null): string {
  const addedAt = dateStr ? new Date(dateStr).getTime() : NaN;
  if (!dateStr || Number.isNaN(addedAt)) return '-';
  const hours = Math.max(Math.floor((Date.now() - addedAt) / HOUR_MS), 0);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365.25)}y`;
}

const COMPACT_COUNT_UNITS: [number, string][] = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'k'],
];

/**
 * Compact magnitude for counters: 1204 -> "1.2k", 3400000 -> "3.4M". Used
 * where card space is tight and exact precision doesn't matter.
 */
export function compactCount(n: number): string {
  const abs = Math.abs(n);
  for (const [threshold, suffix] of COMPACT_COUNT_UNITS) {
    if (abs >= threshold) {
      const rounded = Math.round((n / threshold) * 10) / 10;
      return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
    }
  }
  return String(n);
}
