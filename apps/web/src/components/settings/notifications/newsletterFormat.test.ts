import { describe, it, expect, afterEach } from 'vitest';
import { countsLine, formatClock, outcomeVariant, scheduleSummary } from './newsletterFormat';

const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

describe('scheduleSummary', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('names the weekday in the given locale and the time in the app clock', () => {
    localStorage.setItem('tracearr_time_format', '24h');
    expect(
      scheduleSummary({ kind: 'weekly', dayOfWeek: 1, time: '09:05' }, 'Europe/Berlin', t, 'en-US')
    ).toBe(
      'newsletters.schedule.inZone:{"summary":"newsletters.schedule.weekly:{\\"day\\":\\"Monday\\",\\"time\\":\\"9:05\\"}","timezone":"Europe/Berlin"}'
    );
    expect(scheduleSummary({ kind: 'daily', time: '18:00' }, 'UTC', t, 'en-US')).toContain(
      'newsletters.schedule.daily:{\\"time\\":\\"18:00\\"}'
    );
    expect(
      scheduleSummary({ kind: 'monthly', dayOfMonth: 3, time: '07:30' }, 'UTC', t, 'en-US')
    ).toContain('newsletters.schedule.monthly:{\\"day\\":3,\\"time\\":\\"7:30\\"}');
    expect(
      scheduleSummary({ kind: 'cron', expression: '0 8 * * 1-5' }, 'UTC', t, 'en-US')
    ).toContain('newsletters.schedule.cron:{\\"expression\\":\\"0 8 * * 1-5\\"}');
  });

  it('shows a 12-hour clock when the app is set to it', () => {
    localStorage.setItem('tracearr_time_format', '12h');
    expect(formatClock('18:05')).toBe('6:05 PM');
    localStorage.setItem('tracearr_time_format', '24h');
    expect(formatClock('18:05')).toBe('18:05');
  });
});

describe('outcomeVariant and countsLine', () => {
  it('maps outcomes to badge tones', () => {
    expect(outcomeVariant('sent')).toBe('success');
    expect(outcomeVariant('partial')).toBe('warning');
    expect(outcomeVariant('failed')).toBe('danger');
    expect(outcomeVariant('skipped_empty')).toBe('outline');
    expect(outcomeVariant('rendering')).toBe('secondary');
    expect(outcomeVariant('sending')).toBe('secondary');
  });

  it('joins the three section counts', () => {
    expect(countsLine({ movies: 12, shows: 3, episodes: 40, albums: 0, mostWatched: 0 }, t)).toBe(
      'newsletters.counts.movies:{"count":12}, newsletters.counts.shows:{"count":3}, newsletters.counts.albums:{"count":0}'
    );
    expect(countsLine({}, t)).toBe(
      'newsletters.counts.movies:{"count":0}, newsletters.counts.shows:{"count":0}, newsletters.counts.albums:{"count":0}'
    );
  });
});
