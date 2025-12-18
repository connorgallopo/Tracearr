/**
 * Safe Type Coercion Utilities
 *
 * Provides consistent, safe parsing of unknown API response data into typed values.
 * Used across media server integrations (Plex, Jellyfin) to normalize responses.
 *
 * All functions handle null, undefined, and invalid inputs gracefully.
 */

/**
 * Safely convert unknown value to string
 *
 * @param val - Value to convert
 * @param defaultVal - Default if val is null/undefined (default: '')
 *
 * @example
 * parseString(response.Id) // "abc123"
 * parseString(null) // ""
 * parseString(undefined, 'unknown') // "unknown"
 */
export function parseString(val: unknown, defaultVal = ''): string {
  if (val == null) return defaultVal;
  return String(val);
}

/**
 * Safely convert unknown value to string or undefined
 * Returns undefined if value is null/undefined, otherwise converts to string
 *
 * @example
 * parseOptionalString(response.SeriesName) // "Breaking Bad" or undefined
 */
export function parseOptionalString(val: unknown): string | undefined {
  if (val == null) return undefined;
  return String(val);
}

/**
 * Safely convert unknown value to number
 *
 * @param val - Value to convert
 * @param defaultVal - Default if val is null/undefined/NaN (default: 0)
 *
 * @example
 * parseNumber(response.Duration) // 7200
 * parseNumber(null) // 0
 * parseNumber("invalid") // 0
 */
export function parseNumber(val: unknown, defaultVal = 0): number {
  if (val == null) return defaultVal;
  const num = Number(val);
  return isNaN(num) ? defaultVal : num;
}

/**
 * Safely convert unknown value to number or undefined
 * Returns undefined if value is null/undefined/NaN
 *
 * @example
 * parseOptionalNumber(response.SeasonNumber) // 2 or undefined
 * parseOptionalNumber("invalid") // undefined
 */
export function parseOptionalNumber(val: unknown): number | undefined {
  if (val == null) return undefined;
  const num = Number(val);
  return isNaN(num) ? undefined : num;
}

/**
 * Safely convert unknown value to boolean
 *
 * @param val - Value to convert
 * @param defaultVal - Default if val is null/undefined (default: false)
 *
 * @example
 * parseBoolean(response.IsPaused) // true
 * parseBoolean(null) // false
 * parseBoolean(1) // true
 */
export function parseBoolean(val: unknown, defaultVal = false): boolean {
  if (val == null) return defaultVal;
  return Boolean(val);
}

/**
 * Safely convert unknown value to boolean or undefined
 *
 * @example
 * parseOptionalBoolean(response.IsAdmin) // true or undefined
 */
export function parseOptionalBoolean(val: unknown): boolean | undefined {
  if (val == null) return undefined;
  return Boolean(val);
}

/**
 * Safely parse an array from unknown value and map each element
 *
 * @param val - Value expected to be an array
 * @param mapper - Function to transform each element
 *
 * @example
 * parseArray(response.Sessions, (s) => ({ id: parseString(s.Id) }))
 */
export function parseArray<T>(val: unknown, mapper: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(val)) return [];
  return val.map(mapper);
}

/**
 * Safely parse an array, filtering out items that don't pass predicate
 *
 * @example
 * parseFilteredArray(
 *   response.Sessions,
 *   (s) => s.NowPlayingItem != null,
 *   (s) => ({ id: parseString(s.Id) })
 * )
 */
export function parseFilteredArray<T>(
  val: unknown,
  predicate: (item: unknown) => boolean,
  mapper: (item: unknown, index: number) => T
): T[] {
  if (!Array.isArray(val)) return [];
  return val.filter(predicate).map(mapper);
}

/**
 * Safely get a nested property from an unknown object
 *
 * @example
 * const policy = getNestedObject(user, 'Policy');
 * const isAdmin = parseBoolean(policy?.IsAdministrator);
 */
export function getNestedObject(val: unknown, key: string): Record<string, unknown> | undefined {
  if (val == null || typeof val !== 'object') return undefined;
  const nested = (val as Record<string, unknown>)[key];
  if (nested == null || typeof nested !== 'object') return undefined;
  return nested as Record<string, unknown>;
}

/**
 * Safely get a nested property value
 *
 * @example
 * const isAdmin = getNestedValue(user, 'Policy', 'IsAdministrator');
 */
export function getNestedValue(val: unknown, ...keys: string[]): unknown {
  let current: unknown = val;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Parse a value that can be number or empty string (common in Tautulli API)
 * Returns the number if valid, or null for empty string/invalid
 *
 * @example
 * parseNumberOrEmpty(response.year) // 2024 or null (if "")
 * parseNumberOrEmpty("") // null
 * parseNumberOrEmpty(123) // 123
 */
export function parseNumberOrEmpty(val: unknown): number | null {
  if (val === '' || val == null) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

/**
 * Safely get first element of an array and access a property
 * Useful for patterns like: (item.Media as Record<string, unknown>[])?.[0]?.bitrate
 *
 * @example
 * parseFirstArrayElement(item.Media, 'bitrate', 0) // number from first element
 * parseFirstArrayElement(item.MediaSources, 'Bitrate') // undefined if not found
 */
export function parseFirstArrayElement<T>(
  val: unknown,
  key: string,
  defaultVal?: T
): T | undefined {
  if (!Array.isArray(val) || val.length === 0) return defaultVal;
  const first = val[0];
  if (first == null || typeof first !== 'object') return defaultVal;
  const value = (first as Record<string, unknown>)[key];
  return value !== undefined ? (value as T) : defaultVal;
}

/**
 * Parse string or return null (for nullable DB fields)
 * Unlike parseOptionalString which returns undefined
 *
 * @example
 * parseStringOrNull(response.LastLoginDate) // "2024-01-15" or null
 */
export function parseStringOrNull(val: unknown): string | null {
  if (val == null) return null;
  return String(val);
}

/**
 * Parse ISO date string to Date or null
 *
 * @example
 * parseDate(response.LastLoginDate) // Date object or null
 */
export function parseDate(val: unknown): Date | null {
  if (val == null) return null;
  const str = String(val);
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Parse ISO date string to ISO string or null (for DB storage)
 *
 * @example
 * parseDateString(response.LastLoginDate) // "2024-01-15T10:30:00.000Z" or null
 */
export function parseDateString(val: unknown): string | null {
  const date = parseDate(val);
  return date ? date.toISOString() : null;
}

/**
 * Object with all parsing functions for convenient destructuring
 *
 * @example
 * import { parse } from './parsing.js';
 *
 * const session = {
 *   id: parse.string(data.Id),
 *   duration: parse.number(data.Duration),
 *   isPaused: parse.boolean(data.IsPaused),
 *   seasonNumber: parse.optionalNumber(data.SeasonNumber),
 * };
 */
export const parse = {
  string: parseString,
  optionalString: parseOptionalString,
  stringOrNull: parseStringOrNull,
  number: parseNumber,
  optionalNumber: parseOptionalNumber,
  numberOrEmpty: parseNumberOrEmpty,
  boolean: parseBoolean,
  optionalBoolean: parseOptionalBoolean,
  array: parseArray,
  filteredArray: parseFilteredArray,
  firstArrayElement: parseFirstArrayElement,
  nested: getNestedObject,
  nestedValue: getNestedValue,
  date: parseDate,
  dateString: parseDateString,
} as const;
