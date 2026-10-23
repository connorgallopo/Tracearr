/**
 * Every date, time, weekday and length-of-time helper in the web app, and the per-person
 * conventions they follow: 12- or 24-hour clock, which country's date order to use and which
 * day starts the week. The preferences are stored in localStorage.
 */

import { formatDistanceToNow } from 'date-fns';
import type Highcharts from 'highcharts';
import type { TFunction } from 'i18next';
import { getClientTimezone, type TrendBucket } from '@tracearr/shared';
import { getCurrentLanguage } from '@tracearr/translations';

const TIME_FORMAT_STORAGE_KEY = 'tracearr_time_format';
const DATE_REGION_STORAGE_KEY = 'tracearr_date_region';
const WEEK_START_STORAGE_KEY = 'tracearr_week_start';

// Thai, Persian and Arabic locales otherwise switch the calendar or the digits.
const LOCALE_EXTENSION = '-u-ca-gregory-nu-latn';

export type TimeFormat = '12h' | '24h';
export type DateRegion = 'auto' | (string & {});
/** 0 = Sunday through 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WeekStartPref = 'auto' | 0 | 1 | 6;

/** Countries behind the translation locales (sr-SP is Serbia, RS), plus common English-speaking ones. */
export const DATE_REGIONS: readonly string[] = [
  'AU',
  'BR',
  'CA',
  'CN',
  'CZ',
  'DE',
  'DK',
  'ES',
  'FI',
  'FR',
  'GB',
  'GR',
  'HU',
  'IE',
  'IL',
  'IN',
  'IT',
  'JP',
  'KR',
  'NL',
  'NO',
  'NZ',
  'PL',
  'PT',
  'RO',
  'RS',
  'RU',
  'SA',
  'SE',
  'TR',
  'TW',
  'UA',
  'US',
  'VN',
  'ZA',
];

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Fails in private browsing or when storage is disabled
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Fails in private browsing or when quota exceeded
  }
}

export function getTimeFormat(): TimeFormat {
  const stored = readStorage(TIME_FORMAT_STORAGE_KEY);
  return stored === '24h' ? '24h' : '12h';
}

export function setTimeFormat(format: TimeFormat): void {
  writeStorage(TIME_FORMAT_STORAGE_KEY, format);
}

function getHour12(): boolean {
  return getTimeFormat() !== '24h';
}

export function getDateRegion(): DateRegion {
  const stored = readStorage(DATE_REGION_STORAGE_KEY);
  return stored && DATE_REGIONS.includes(stored) ? stored : 'auto';
}

export function setDateRegion(region: DateRegion): void {
  writeStorage(DATE_REGION_STORAGE_KEY, region);
}

export function getWeekStartPref(): WeekStartPref {
  const stored = readStorage(WEEK_START_STORAGE_KEY);
  return stored === '0' || stored === '1' || stored === '6'
    ? (Number(stored) as 0 | 1 | 6)
    : 'auto';
}

export function setWeekStartPref(pref: WeekStartPref): void {
  writeStorage(WEEK_START_STORAGE_KEY, String(pref));
}

export const browserTimeZone = getClientTimezone;

/** The language-country pair, when CLDR has data for it rather than resolving to the bare language. */
function pairedLocale(language: string, country: string): string | undefined {
  const pair = `${language}-${country}`;
  const resolved = new Intl.DateTimeFormat(pair).resolvedOptions().locale;
  return new Intl.Locale(resolved).region === country ? pair : undefined;
}

function regionOf(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).region;
  } catch {
    // navigator.languages can hold tags Intl rejects, such as 'en_US'
    return undefined;
  }
}

export function resolveFormatLocale(
  uiLanguage: string,
  region: DateRegion,
  browserLocales: readonly string[]
): string {
  const language = new Intl.Locale(uiLanguage).language;
  if (region !== 'auto') {
    const fallback = `${new Intl.Locale(`und-${region}`).maximize().language}-${region}`;
    return (pairedLocale(language, region) ?? fallback) + LOCALE_EXTENSION;
  }
  for (const browserLocale of browserLocales) {
    const country = regionOf(browserLocale);
    const paired = country ? pairedLocale(language, country) : undefined;
    if (paired) return paired + LOCALE_EXTENSION;
  }
  return uiLanguage + LOCALE_EXTENSION;
}

type WeekInfo = { firstDay: number };

/** First day of the week for a locale, 0 = Sunday. */
export function localeFirstDay(locale: string): Weekday {
  const intlLocale = new Intl.Locale(locale) as Intl.Locale & {
    getWeekInfo?: () => WeekInfo;
    weekInfo?: WeekInfo;
  };
  const firstDay = (intlLocale.getWeekInfo?.() ?? intlLocale.weekInfo)?.firstDay;
  return (firstDay === undefined ? 0 : firstDay % 7) as Weekday;
}

const resolvedLocales = new Map<string, string>();

export function getFormatLocale(): string {
  const uiLanguage = getCurrentLanguage();
  const region = getDateRegion();
  const key = [uiLanguage, region, ...navigator.languages].join('|');
  let locale = resolvedLocales.get(key);
  if (!locale) {
    locale = resolveFormatLocale(uiLanguage, region, navigator.languages);
    resolvedLocales.set(key, locale);
  }
  return locale;
}

export function getWeekStart(): Weekday {
  const pref = getWeekStartPref();
  return pref === 'auto' ? localeFirstDay(getFormatLocale()) : pref;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatDate(date: Date | number, options: Intl.DateTimeFormatOptions): string {
  const locale = getFormatLocale();
  const withHour12 =
    options.hour !== undefined || options.timeStyle !== undefined
      ? { ...options, hour12: getHour12() }
      : options;
  const key = `${locale}|${JSON.stringify(withHour12)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, withHour12);
    formatters.set(key, formatter);
  }
  // ICU 72+ puts a narrow no-break space before AM; plain spaces keep text matching working.
  return formatter.format(date).replace(/\u202f/g, ' ');
}

/** Day name for 0 = Sunday through 6 = Saturday. */
export function weekdayName(day: number, width: 'short' | 'long'): string {
  // 2026-01-04 was a Sunday.
  return formatDate(Date.UTC(2026, 0, 4 + day), { weekday: width, timeZone: 'UTC' });
}

/** Day numbers (0 = Sunday) in display order, starting at the week start. */
export function orderedWeekdays(): number[] {
  const start = getWeekStart();
  return Array.from({ length: 7 }, (_, i) => (start + i) % 7);
}

/** An hour of the day (0-23) in the person's clock and region, such as "1 PM" or "13:00". */
export function formatHourOfDay(hour: number): string {
  return formatDate(new Date(2024, 0, 1, hour), {
    hour: 'numeric',
    ...(getHour12() ? {} : { minute: '2-digit' }),
  });
}

/** "HH:MM" from the schedule shown in the app's 12- or 24-hour clock. */
export function formatClock(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const at = new Date(2026, 0, 1, hours ?? 0, minutes ?? 0);
  return formatDate(at, { hour: 'numeric', minute: '2-digit' });
}

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
 * Safely format a date with Intl options.
 * Returns fallback string for invalid dates.
 */
export function safeFormatDate(
  date: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  fallback = 'Unknown'
): string {
  const parsed = safeParseDate(date);
  if (!parsed) return fallback;
  return formatDate(parsed, options);
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

/** The current year is implied; anything older says which year it came from. */
export function dateLabel(iso: string): string {
  const date = new Date(iso);
  return formatDate(date, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The calendar year an instant falls in inside the given zone, which is not always the browser's. */
const yearIn = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }).format(date);

/** dateLabel in a named zone instead of the browser's: the newsletter's schedule is stored in its own zone. */
export function zonedDateLabel(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const sameYear = yearIn(date, timeZone) === yearIn(new Date(), timeZone);
  return formatDate(date, {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

export const FULL_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  ...DATE_TIME_OPTIONS,
  year: 'numeric',
};

export function windowLabel(iso: string, timeZone?: string): string {
  return formatDate(new Date(iso), { month: 'short', day: 'numeric', timeZone });
}

/** YYYY-MM-DD in the browser's zone (toISOString would shift the day west of UTC); '' for an invalid date. */
export function toIsoDate(date: Date): string {
  if (isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight of a YYYY-MM-DD day, the inverse of toIsoDate; undefined for anything else, including 2026-02-30. */
export function fromIsoDate(value: string | null | undefined): Date | undefined {
  if (!value || !ISO_DAY.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return toIsoDate(date) === value ? date : undefined;
}

// The library aggregates are UTC-day rows, so a picked calendar day goes to the server as
// that day's UTC midnight whatever zone the browser is in.
export function utcDayStart(date: Date, plusDays = 0): string {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + plusDays)
  ).toISOString();
}

/** The exclusive end of a picked last day: the start of the next day in the browser's zone. */
export function nextLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

export function todayString(): string {
  return toIsoDate(new Date());
}

/** A UTC day bucket as its calendar date, whatever the browser's zone. */
export function formatUtcDay(iso: string): string {
  const day = new Date(iso);
  const local = new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return formatDate(
    local,
    local.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { dateStyle: 'medium' }
  );
}

/** A YYYY-MM-DD day as a medium date; '' when it does not parse. */
export function formatIsoDay(isoDate: string): string {
  return formatDateString(isoDate, { dateStyle: 'medium' });
}

/** A date range filter's chip text: between, after or before, or '' when neither end is set. */
export function formatFilterDateRange(
  value: { from?: string; to?: string },
  t: TFunction<['pages', 'common']>
): string {
  const from = value.from ? formatIsoDay(value.from) : undefined;
  const to = value.to ? formatIsoDay(value.to) : undefined;
  if (from && to) return t('common:filters.dateBetween', { from, to });
  if (from) return t('common:filters.dateAfter', { date: from });
  if (to) return t('common:filters.dateBefore', { date: to });
  return '';
}

export function formatCustomRange(startDate: Date, endDate: Date): string {
  return `${formatDate(startDate, { month: 'short', day: 'numeric' })} - ${formatDate(endDate, { dateStyle: 'medium' })}`;
}

export function formatLastUpdated(dateStr: string | null | undefined): string {
  return safeFormatDate(
    dateStr,
    { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' },
    ''
  );
}

const SAMPLE_DATE = Date.UTC(2026, 4, 17, 12);

/** A fixed date in short and medium style as a region choice would print it, for that choice's label. */
export function sampleDate(language: string, region: DateRegion): string {
  const locale = resolveFormatLocale(language, region, navigator.languages);
  const sample = (dateStyle: 'short' | 'medium') =>
    new Intl.DateTimeFormat(locale, { dateStyle, timeZone: 'UTC' }).format(SAMPLE_DATE);
  return `${sample('short')} · ${sample('medium')}`;
}

/**
 * The distinct formats a pick can give, other than Automatic's, each under its first region.
 * The saved region always keeps its own row so the select holds exactly what is stored.
 */
export function dateFormatChoices(
  language: string,
  saved: DateRegion
): { region: string; sample: string }[] {
  const seen = new Set<string>();
  const choices: { region: string; sample: string }[] = [];
  const add = (region: string) => {
    const sample = sampleDate(language, region);
    if (seen.has(sample)) return;
    seen.add(sample);
    choices.push({ region, sample });
  };
  if (saved !== 'auto') add(saved);
  seen.add(sampleDate(language, 'auto'));
  DATE_REGIONS.forEach(add);
  return choices.sort((a, b) => a.sample.localeCompare(b.sample, language));
}

/**
 * Parse a date string to timestamp for Highcharts datetime axis.
 * Handles ISO dates ("YYYY-MM-DD") and PostgreSQL timestamps ("YYYY-MM-DD HH:mm:ss+TZ").
 */
export function parseChartDate(dateStr: string): number {
  if (dateStr.includes(' ')) {
    // PostgreSQL timestamp: "2026-01-28 05:00:00+00" -> "2026-01-28T05:00:00+00:00"
    const normalized = dateStr.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    return new Date(normalized).getTime();
  }
  return fromIsoDate(dateStr)?.getTime() ?? NaN;
}

/** A chart date string (see parseChartDate) formatted with the given options; '' when it does not parse. */
export function formatDateString(dateStr: string, options: Intl.DateTimeFormatOptions): string {
  return safeFormatDate(new Date(parseChartDate(dateStr)), options, '');
}

/** Short label for the start of a trend bucket (YYYY-MM-DD): a month name for months, a date otherwise. */
export function formatTrendDate(start: string, bucket: TrendBucket): string {
  return formatDateString(
    start,
    bucket === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' }
  );
}

/** Tooltip heading for a range chart bucket: weeks for all time, days for a month or year, hours otherwise. */
export function formatBucketDate(
  x: number,
  period: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom',
  weekOf: (date: string) => string
): string {
  if (period === 'all') {
    return weekOf(formatDate(x, { month: 'short', day: 'numeric', year: 'numeric' }));
  }
  if (period === 'year' || period === 'month') {
    return formatDate(x, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return formatDate(x, { month: 'short', day: 'numeric', hour: 'numeric' });
}

/** Datetime axis tick labels in the person's formatting locale; hours only for charts with hourly buckets. */
export function axisDateTimeLabelFormats(
  withHours = false
): Highcharts.AxisDateTimeLabelFormatsOptions {
  const dayLabel: { main: Intl.DateTimeFormatOptions } = {
    main: { month: 'short', day: 'numeric' },
  };
  const formats = {
    day: dayLabel,
    week: dayLabel,
    month: { main: { month: 'short', year: 'numeric' } },
    year: { main: { year: 'numeric' } },
    ...(withHours && {
      hour: {
        main: getHour12()
          ? { hour: 'numeric', hour12: true }
          : { hour: 'numeric', minute: '2-digit', hour12: false },
      },
    }),
  } satisfies Record<string, { main: Intl.DateTimeFormatOptions }>;
  // Highcharts 13 formats an Intl options object given as `main`, but its d.ts types `main` as a strftime string.
  return formats as unknown as Highcharts.AxisDateTimeLabelFormatsOptions;
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
 * @param options.emptyValue - Custom empty value (default: '--:--' for clock, '-' for others)
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
    return style === 'clock' ? '--:--' : '-';
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

export function formatWatchTime(ms: number): string {
  if (!ms) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const remainingHours = hours % 24;
  const days = Math.floor(hours / 24);
  const remainingDays = days % 365;
  const years = Math.floor(days / 365);

  if (years > 0) {
    return `${years}yr ${remainingDays}d ${remainingHours}h`;
  }
  if (days > 0) {
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** One unit that grows with the total: minutes, then hours, days from two days, weeks from two weeks. */
export function spanOf(ms: number): {
  unit: 'minutes' | 'hours' | 'days' | 'weeks';
  count: number;
} {
  const round = (value: number) => Math.round(value * 10) / 10;
  if (ms < HOUR_MS) return { unit: 'minutes', count: Math.round(ms / 60_000) };
  if (ms < 2 * DAY_MS) return { unit: 'hours', count: round(ms / HOUR_MS) };
  if (ms < 2 * WEEK_MS) return { unit: 'days', count: round(ms / DAY_MS) };
  return { unit: 'weeks', count: round(ms / WEEK_MS) };
}

/** A schedule interval in a single unit, fractional when it does not divide: "30s", "5m", "1.5h". */
export function formatInterval(ms: number, emptyValue: string): string {
  if (ms === 0) return emptyValue;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  return `${minutes / 60}h`;
}

/** Whole hours only, matching the mockup's "182h" / "36h" kpi values (no day breakdown). */
export function formatKpiHours(ms: number): string {
  return `${Math.round(ms / HOUR_MS)}h`;
}

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

export function formatStaleTime(days: number, t: TFunction<'pages'>): string {
  if (days < 30) return t('library.storage.stale.age.days', { count: days });
  if (days < 365) return t('library.storage.stale.age.months', { count: Math.floor(days / 30) });
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  if (months === 0) return t('library.storage.stale.age.years', { count: years });
  return t('library.storage.stale.age.yearsMonths', { years, months });
}
