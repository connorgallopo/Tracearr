/**
 * Date, time, and number formatting utilities.
 *
 * Uses the native Intl API for locale-aware formatting.
 * Works consistently across web and React Native environments.
 */

import i18n from 'i18next';

// ============================================================================
// Date/Time Formatting
// ============================================================================

/**
 * Format options for dates and times.
 */
export type DateFormatStyle = 'short' | 'medium' | 'long' | 'full';

/**
 * Format a date using the current locale.
 *
 * @param date - Date to format
 * @param style - Format style ('short', 'medium', 'long', 'full')
 * @returns Formatted date string
 *
 * @example
 * formatDate(new Date(), 'short')  // "1/2/26" (en-US)
 * formatDate(new Date(), 'long')   // "January 2, 2026" (en-US)
 */
export function formatDate(date: Date | number, style: DateFormatStyle = 'medium'): string {
  const locale = i18n.language || 'en';
  const d = typeof date === 'number' ? new Date(date) : date;

  if (isNaN(d.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: style,
  }).format(d);
}

/**
 * Format a time using the current locale.
 *
 * @param date - Date to format
 * @param style - Format style ('short', 'medium', 'long', 'full')
 * @returns Formatted time string
 *
 * @example
 * formatTime(new Date(), 'short')  // "3:30 PM" (en-US)
 */
export function formatTime(date: Date | number, style: DateFormatStyle = 'short'): string {
  const locale = i18n.language || 'en';
  const d = typeof date === 'number' ? new Date(date) : date;

  if (isNaN(d.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(locale, {
    timeStyle: style,
  }).format(d);
}

/**
 * Format a date and time using the current locale.
 *
 * @param date - Date to format
 * @param dateStyle - Date format style
 * @param timeStyle - Time format style
 * @returns Formatted datetime string
 *
 * @example
 * formatDateTime(new Date(), 'short', 'short')  // "1/2/26, 3:30 PM" (en-US)
 */
export function formatDateTime(
  date: Date | number,
  dateStyle: DateFormatStyle = 'short',
  timeStyle: DateFormatStyle = 'short'
): string {
  const locale = i18n.language || 'en';
  const d = typeof date === 'number' ? new Date(date) : date;

  if (isNaN(d.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle,
    timeStyle,
  }).format(d);
}

// ============================================================================
// Relative Time Formatting
// ============================================================================

/**
 * Format a relative time (e.g., "2 hours ago", "in 3 days").
 *
 * @param date - Date to compare to now
 * @param now - Reference time (defaults to current time)
 * @returns Formatted relative time string
 *
 * @example
 * formatRelativeTime(Date.now() - 3600000)  // "1 hour ago"
 * formatRelativeTime(Date.now() + 86400000) // "in 1 day"
 */
export function formatRelativeTime(date: Date | number, now: Date | number = Date.now()): string {
  const locale = i18n.language || 'en';
  const d = typeof date === 'number' ? date : date.getTime();
  const n = typeof now === 'number' ? now : now.getTime();

  if (isNaN(d) || isNaN(n)) {
    return '';
  }

  const diff = d - n;
  const absDiff = Math.abs(diff);

  // Select appropriate unit
  const seconds = absDiff / 1000;
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  const weeks = days / 7;
  const months = days / 30;
  const years = days / 365;

  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;

  if (seconds < 60) {
    value = Math.round(seconds);
    unit = 'second';
  } else if (minutes < 60) {
    value = Math.round(minutes);
    unit = 'minute';
  } else if (hours < 24) {
    value = Math.round(hours);
    unit = 'hour';
  } else if (days < 7) {
    value = Math.round(days);
    unit = 'day';
  } else if (weeks < 4) {
    value = Math.round(weeks);
    unit = 'week';
  } else if (months < 12) {
    value = Math.round(months);
    unit = 'month';
  } else {
    value = Math.round(years);
    unit = 'year';
  }

  // Adjust sign for past/future
  const signedValue = diff < 0 ? -value : value;

  return new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
  }).format(signedValue, unit);
}

// ============================================================================
// Duration Formatting
// ============================================================================

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @param options - Formatting options
 * @returns Formatted duration string
 *
 * @example
 * formatDuration(3661000)           // "1h 1m 1s"
 * formatDuration(3661000, { style: 'long' })  // "1 hour, 1 minute, 1 second"
 */
export function formatDuration(
  ms: number,
  options: { style?: 'short' | 'long'; maxUnits?: number } = {}
): string {
  const { style = 'short', maxUnits = 3 } = options;

  if (ms < 0) ms = 0;

  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000) % 24;
  const days = Math.floor(ms / 86400000);

  const parts: string[] = [];

  if (style === 'short') {
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  } else {
    // Long style - use i18n translation keys with pluralization
    if (days > 0) parts.push(i18n.t('common:duration.day', { count: days }));
    if (hours > 0) parts.push(i18n.t('common:duration.hour', { count: hours }));
    if (minutes > 0) parts.push(i18n.t('common:duration.minute', { count: minutes }));
    if (seconds > 0 || parts.length === 0)
      parts.push(i18n.t('common:duration.second', { count: seconds }));
  }

  return parts.slice(0, maxUnits).join(style === 'short' ? ' ' : ', ');
}

// ============================================================================
// Number Formatting
// ============================================================================

/**
 * Format a number using the current locale.
 *
 * @param value - Number to format
 * @param options - Intl.NumberFormat options
 * @returns Formatted number string
 *
 * @example
 * formatNumber(1234567.89)  // "1,234,567.89" (en-US)
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const locale = i18n.language || 'en';
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Format a number as a percentage.
 *
 * @param value - Number to format (0-1 or 0-100 depending on usePercent)
 * @param decimals - Number of decimal places
 * @param usePercent - If true, value is already a percentage (0-100)
 * @returns Formatted percentage string
 *
 * @example
 * formatPercent(0.75)        // "75%"
 * formatPercent(75, 1, true) // "75.0%"
 */
export function formatPercent(value: number, decimals = 0, usePercent = false): string {
  const locale = i18n.language || 'en';
  const normalizedValue = usePercent ? value / 100 : value;

  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(normalizedValue);
}

/**
 * Format bytes to a human-readable size string.
 *
 * @param bytes - Number of bytes
 * @param decimals - Number of decimal places
 * @returns Formatted size string
 *
 * @example
 * formatBytes(1024)       // "1 KB"
 * formatBytes(1536, 1)    // "1.5 KB"
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  if (bytes < 0) bytes = 0;

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const value = bytes / Math.pow(k, i);

  return `${formatNumber(value, { maximumFractionDigits: decimals })} ${sizes[i]}`;
}

/**
 * Format a bitrate to a human-readable string.
 *
 * @param bitsPerSecond - Bitrate in bits per second
 * @param decimals - Number of decimal places
 * @returns Formatted bitrate string
 *
 * @example
 * formatBitrate(8000000)  // "8 Mbps"
 */
export function formatBitrate(bitsPerSecond: number, decimals = 1): string {
  if (bitsPerSecond === 0) return '0 bps';
  if (bitsPerSecond < 0) bitsPerSecond = 0;

  const k = 1000;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  const i = Math.min(Math.floor(Math.log(bitsPerSecond) / Math.log(k)), sizes.length - 1);
  const value = bitsPerSecond / Math.pow(k, i);

  return `${formatNumber(value, { maximumFractionDigits: decimals })} ${sizes[i]}`;
}
