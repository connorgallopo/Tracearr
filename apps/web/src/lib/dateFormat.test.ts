import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import {
  browserTimeZone,
  dateFormatChoices,
  formatClock,
  formatCompactAge,
  formatDate,
  formatDuration,
  formatFilterDateRange,
  formatHourOfDay,
  formatInterval,
  formatIsoDay,
  formatKpiHours,
  formatLastUpdated,
  formatTrendDate,
  fromIsoDate,
  getDateRegion,
  getWeekStart,
  getWeekStartPref,
  localeFirstDay,
  orderedWeekdays,
  parseChartDate,
  resolveFormatLocale,
  safeFormatDate,
  sampleDate,
  setDateRegion,
  setTimeFormat,
  setWeekStartPref,
  toIsoDate,
  windowLabel,
  zonedDateLabel,
} from './dateFormat';

vi.mock('@tracearr/translations', () => ({
  getCurrentLanguage: () => 'en',
}));

beforeEach(() => {
  localStorage.clear();
});

describe('resolveFormatLocale', () => {
  it('pairs the UI language with the chosen country', () => {
    expect(resolveFormatLocale('en', 'DE', ['en-US'])).toBe('en-DE-u-ca-gregory-nu-latn');
  });

  it('falls back to the country locale when the pair is missing', () => {
    expect(resolveFormatLocale('en', 'BR', ['en-US'])).toBe('pt-BR-u-ca-gregory-nu-latn');
  });

  it('automatic pairs the UI language with the browser country', () => {
    expect(resolveFormatLocale('en', 'auto', ['en-GB'])).toBe('en-GB-u-ca-gregory-nu-latn');
  });

  it('automatic keeps a non-English UI locale when the pair is missing', () => {
    expect(resolveFormatLocale('fi-FI', 'auto', ['en-US'])).toBe('fi-FI-u-ca-gregory-nu-latn');
  });

  it('automatic with no browser country stays on the UI language', () => {
    expect(resolveFormatLocale('en', 'auto', ['en'])).toBe('en-u-ca-gregory-nu-latn');
  });

  it('automatic skips a browser tag Intl rejects', () => {
    expect(resolveFormatLocale('en', 'auto', ['en_US', 'en-GB'])).toBe(
      'en-GB-u-ca-gregory-nu-latn'
    );
  });

  it('pins the Gregorian calendar for Thailand', () => {
    const locale = resolveFormatLocale('en', 'TH', []);
    expect(
      new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }).format(
        Date.UTC(2026, 4, 17)
      )
    ).toContain('2026');
  });
});

describe('localeFirstDay', () => {
  it('is Monday in Germany and Sunday in the US', () => {
    expect(localeFirstDay('en-DE')).toBe(1);
    expect(localeFirstDay('en-US')).toBe(0);
  });
});

describe('preferences', () => {
  it('reads junk storage as automatic', () => {
    localStorage.setItem('tracearr_date_region', 'zz');
    localStorage.setItem('tracearr_week_start', 'tuesday');
    expect(getDateRegion()).toBe('auto');
    expect(getWeekStartPref()).toBe('auto');
  });

  it('an explicit week start beats the locale', () => {
    setDateRegion('US');
    setWeekStartPref(1);
    expect(getWeekStart()).toBe(1);
    expect(orderedWeekdays()).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

describe('date format choices', () => {
  it('lists each format once, previewing short and medium dates, apart from automatic', () => {
    const samples = dateFormatChoices('en', 'auto').map((choice) => choice.sample);
    expect(new Set(samples).size).toBe(samples.length);
    expect(samples).not.toContain(sampleDate('en', 'auto'));
    expect(samples).toContain('17/05/2026 · 17 May 2026');
  });

  it('keeps the saved region as its own row', () => {
    expect(dateFormatChoices('en', 'NZ').map((choice) => choice.region)).toContain('NZ');
    expect(dateFormatChoices('en', 'US').map((choice) => choice.region)).toContain('US');
  });
});

describe('formatDate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('orders a chosen country day-first and keeps English month names', () => {
    setDateRegion('GB');
    expect(formatDate(Date.UTC(2026, 4, 17, 12), { dateStyle: 'medium', timeZone: 'UTC' })).toBe(
      '17 May 2026'
    );
  });

  it('uses plain spaces around the day period', () => {
    // format is a getter returning a bound function, which the DateTimeFormat type hides.
    vi.spyOn(Intl.DateTimeFormat.prototype as { format: unknown }, 'format', 'get').mockReturnValue(
      () => '3:30\u202fPM'
    );
    setDateRegion('US');
    localStorage.setItem('tracearr_time_format', '12h');
    expect(
      formatDate(Date.UTC(2026, 4, 17, 15, 30), {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'UTC',
      })
    ).toBe('3:30 PM');
  });
});

describe('formatHourOfDay', () => {
  it('follows the 12-hour clock', () => {
    setDateRegion('US');
    setTimeFormat('12h');
    expect(formatHourOfDay(0)).toBe('12 AM');
    expect(formatHourOfDay(13)).toBe('1 PM');
  });

  it('follows the 24-hour clock', () => {
    setDateRegion('US');
    setTimeFormat('24h');
    expect(formatHourOfDay(0)).toBe('00:00');
    expect(formatHourOfDay(13)).toBe('13:00');
  });
});

describe('formatIsoDay', () => {
  it('shows a filter value as a medium date', () => {
    setDateRegion('US');
    expect(formatIsoDay('2026-05-17')).toBe('May 17, 2026');
  });

  it('returns empty text for a value that is not a day', () => {
    expect(formatIsoDay('2026-02-30')).toBe('');
  });
});

describe('formatFilterDateRange', () => {
  it('names both ends, one end, or neither', () => {
    setDateRegion('US');
    const t = ((key: string, vars?: Record<string, unknown>) =>
      `${key}:${JSON.stringify(vars ?? {})}`) as unknown as Parameters<
      typeof formatFilterDateRange
    >[1];
    expect(formatFilterDateRange({ from: '2026-05-01', to: '2026-05-17' }, t)).toBe(
      'common:filters.dateBetween:{"from":"May 1, 2026","to":"May 17, 2026"}'
    );
    expect(formatFilterDateRange({ to: '2026-05-17' }, t)).toBe(
      'common:filters.dateBefore:{"date":"May 17, 2026"}'
    );
    expect(formatFilterDateRange({}, t)).toBe('');
  });
});

describe('formatInterval', () => {
  it('uses one unit, fractional when it does not divide', () => {
    expect(formatInterval(30_000, 'none')).toBe('30s');
    expect(formatInterval(300_000, 'none')).toBe('5m');
    expect(formatInterval(5_400_000, 'none')).toBe('1.5h');
    expect(formatInterval(0, 'none')).toBe('none');
  });
});

describe('invalid dates', () => {
  it('fall back to empty text instead of throwing', () => {
    expect(formatLastUpdated('garbage')).toBe('');
    expect(formatTrendDate('garbage', 'day')).toBe('');
  });
});

describe('formatClock', () => {
  it('shows a 12-hour clock when the app is set to it', () => {
    localStorage.setItem('tracearr_time_format', '12h');
    expect(formatClock('18:05')).toBe('6:05 PM');
    localStorage.setItem('tracearr_time_format', '24h');
    expect(formatClock('18:05')).toBe('18:05');
  });
});

describe('windowLabel', () => {
  it('formats a window date as month and day', () => {
    expect(windowLabel('2026-08-28T12:00:00.000Z', 'UTC')).toBe('Aug 28');
  });
});

const year = new Date().getFullYear();

describe('zonedDateLabel', () => {
  it('formats the instant in the given zone with a plain space before the meridiem', () => {
    expect(zonedDateLabel(`${year}-09-14T13:00:00.000Z`, 'America/New_York')).toBe(
      'Sep 14, 9:00 AM'
    );
    expect(zonedDateLabel(`${year}-09-14T13:00:00.000Z`, 'Europe/Berlin')).toBe('Sep 14, 3:00 PM');
  });

  it('adds the year for an instant outside the current year', () => {
    expect(zonedDateLabel(`${year - 1}-01-05T12:00:00.000Z`, 'UTC')).toBe(
      `Jan 5, ${year - 1}, 12:00 PM`
    );
  });

  it('decides the year in the given zone, so a New Year instant reads as next year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    expect(zonedDateLabel('2026-12-31T16:00:00.000Z', 'Asia/Tokyo')).toBe('Jan 1, 2027, 1:00 AM');
    vi.useRealTimers();
  });
});

describe('safeFormatDate', () => {
  it('safeFormatDate returns the fallback for an unparseable date', () => {
    expect(safeFormatDate('not-a-date', { dateStyle: 'medium' })).toBe('Unknown');
  });
});

describe('parseChartDate', () => {
  it('parses an ISO date string to local midnight timestamp', () => {
    const ts = parseChartDate('2026-01-28');
    expect(ts).toBe(new Date('2026-01-28T00:00:00').getTime());
  });

  it('parses a PostgreSQL timestamp with space separator', () => {
    const ts = parseChartDate('2026-01-28 05:00:00+00');
    expect(ts).toBe(new Date('2026-01-28T05:00:00+00:00').getTime());
  });
});

describe('browserTimeZone', () => {
  it('reads the browser zone for a new row', () => {
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe('fromIsoDate', () => {
  it('reads a day as local midnight and round-trips through toIsoDate', () => {
    const date = fromIsoDate('2026-01-05');
    expect(date?.getTime()).toBe(new Date(2026, 0, 5).getTime());
    expect(date && toIsoDate(date)).toBe('2026-01-05');
  });

  it('rejects an overflowing day, a timestamp and an empty value', () => {
    expect(fromIsoDate('2026-02-30')).toBeUndefined();
    expect(fromIsoDate('2026-01-05T10:00:00Z')).toBeUndefined();
    expect(fromIsoDate(null)).toBeUndefined();
  });
});

describe('toIsoDate', () => {
  it('writes the calendar day in the browser zone', () => {
    expect(toIsoDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('returns empty text for an invalid date instead of throwing', () => {
    expect(toIsoDate(new Date('garbage'))).toBe('');
  });
});

describe('formatDuration', () => {
  it('uses a hyphen for an empty duration outside the clock style', () => {
    expect(formatDuration(0, { style: 'compact' })).toBe('-');
    expect(formatDuration(null, { style: 'clock' })).toBe('--:--');
  });

  it('keeps zero seconds in the compact style and pads the clock style', () => {
    expect(formatDuration(60_000, { style: 'compact' })).toBe('1m 0s');
    expect(formatDuration(245_000)).toBe('4:05');
  });
});

describe('formatKpiHours', () => {
  it('rounds milliseconds down to whole hours', () => {
    expect(formatKpiHours(655_200_000)).toBe('182h');
  });
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

describe('formatCompactAge', () => {
  it('formats an age under 24 hours in hours', () => {
    expect(formatCompactAge(hoursAgo(14))).toBe('14h');
  });

  it('formats an age under 60 days in days', () => {
    expect(formatCompactAge(daysAgo(5))).toBe('5d');
  });

  it('formats an age of 60+ days but under 52 weeks in weeks', () => {
    expect(formatCompactAge(daysAgo(105))).toBe('15w');
  });

  it('formats an age of 52+ weeks but under 12 months in months', () => {
    expect(formatCompactAge(daysAgo(365))).toBe('11mo');
  });

  it('formats an age of 12+ months in years', () => {
    expect(formatCompactAge(daysAgo(800))).toBe('2y');
  });

  it('falls back to a dash for an empty date string', () => {
    expect(formatCompactAge('')).toBe('-');
  });

  it('falls back to a dash for an unparseable date string', () => {
    expect(formatCompactAge('not-a-date')).toBe('-');
  });

  it('falls back to a dash for a null date', () => {
    expect(formatCompactAge(null)).toBe('-');
  });
});
