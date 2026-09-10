import { describe, it, expect, vi } from 'vitest';
import { zonedDateLabel } from './dateLabel';

const year = new Date().getFullYear();

describe('zonedDateLabel', () => {
  it('formats the instant in the given zone with a plain space before the meridiem', () => {
    expect(zonedDateLabel(`${year}-09-14T13:00:00.000Z`, 'America/New_York', 'en-US')).toBe(
      'Sep 14, 9:00 AM'
    );
    expect(zonedDateLabel(`${year}-09-14T13:00:00.000Z`, 'Europe/Berlin', 'en-US')).toBe(
      'Sep 14, 3:00 PM'
    );
  });

  it('adds the year for an instant outside the current year', () => {
    expect(zonedDateLabel(`${year - 1}-01-05T12:00:00.000Z`, 'UTC', 'en-US')).toBe(
      `Jan 5, ${year - 1}, 12:00 PM`
    );
  });

  it('decides the year in the given zone, so a New Year instant reads as next year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    expect(zonedDateLabel('2026-12-31T16:00:00.000Z', 'Asia/Tokyo', 'en-US')).toBe(
      'Jan 1, 2027, 1:00 AM'
    );
    vi.useRealTimers();
  });
});
