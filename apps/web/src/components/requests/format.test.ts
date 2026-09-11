import { describe, it, expect } from 'vitest';
import { format } from 'date-fns';
import type { MediaRequestEntry } from '@tracearr/shared';
import { formatWait, formatSeasons, heroRequestLine } from './format';

const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

describe('formatWait', () => {
  it('reads as declined for a declined request regardless of waitMs', () => {
    expect(formatWait(null, 'declined', t)).toBe('requests.wait.declined');
    expect(formatWait(5000, 'declined', t)).toBe('requests.wait.declined');
  });

  it('reads as declined for a failed request', () => {
    expect(formatWait(null, 'failed', t)).toBe('requests.wait.declined');
  });

  it('reads as pending for a pending request with no wait yet', () => {
    expect(formatWait(null, 'pending', t)).toBe('requests.wait.pending');
  });

  it('reads as pending for an approved request still awaiting availability', () => {
    expect(formatWait(null, 'approved', t)).toBe('requests.wait.pending');
  });

  it('reads as landed within a minute under 60 seconds', () => {
    expect(formatWait(59_000, 'completed', t)).toBe('requests.wait.sameMinute');
  });

  it('reads as landed with the formatted duration at 60 seconds and up', () => {
    expect(formatWait(60_000, 'completed', t)).toBe('requests.wait.landed:{"duration":"1m"}');
    expect(formatWait(3 * 60 * 60 * 1000 + 5 * 60 * 1000, 'completed', t)).toBe(
      'requests.wait.landed:{"duration":"3h 5m"}'
    );
  });
});

describe('formatSeasons', () => {
  it('returns null for a movie request', () => {
    expect(formatSeasons(null, t)).toBeNull();
  });

  it('returns all seasons for an empty list', () => {
    expect(formatSeasons([], t)).toBe('requests.seasons.all');
  });

  it('lists season numbers sorted and comma joined', () => {
    expect(
      formatSeasons(
        [
          { seasonNumber: 3, status: 'pending' },
          { seasonNumber: 1, status: 'pending' },
        ],
        t
      )
    ).toBe('requests.seasons.list:{"list":"1, 3"}');
  });
});

function makeEntry(overrides: Partial<MediaRequestEntry> = {}): MediaRequestEntry {
  return {
    id: 'r1',
    serverId: 's1',
    status: 'completed',
    requestedAt: '2026-01-01T00:00:00.000Z',
    availableAt: '2026-01-02T00:00:00.000Z',
    waitMs: 24 * 60 * 60 * 1000,
    deletedAt: null,
    seasons: null,
    is4k: false,
    isAutoRequest: false,
    watchedState: 'unwatched',
    requester: {
      serverUserId: 'u1',
      userId: 'u1',
      serverId: 's1',
      username: 'alice',
      identityName: 'Alice',
      thumb: null,
    },
    ...overrides,
  };
}

describe('heroRequestLine', () => {
  it('fills name, date and the landed tail for a completed request', () => {
    const entry = makeEntry();
    const line = heroRequestLine(entry, 'Alice', t, 'MMM d, yyyy');
    const date = format(new Date(entry.requestedAt), 'MMM d, yyyy');
    expect(line).toBe(
      `requests.hero.line:{"name":"Alice","date":"${date}","tail":"requests.wait.landed:{\\"duration\\":\\"24h 0m\\"}"}`
    );
  });

  it('fills the declined tail for a declined request', () => {
    const line = heroRequestLine(
      makeEntry({ status: 'declined', availableAt: null, waitMs: null }),
      'Alice',
      t,
      'MMM d, yyyy'
    );
    expect(line).toContain('"tail":"requests.wait.declined"');
  });

  it('fills the still-waiting tail for a pending request', () => {
    const line = heroRequestLine(
      makeEntry({ status: 'pending', availableAt: null, waitMs: null }),
      'Alice',
      t,
      'MMM d, yyyy'
    );
    expect(line).toContain('"tail":"requests.wait.pending"');
  });
});
