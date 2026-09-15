import { describe, expect, it } from 'vitest';
import { computeWindow } from '../window.js';

const NOW = new Date('2026-09-02T18:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('computeWindow', () => {
  it('fixed windows count back from now', () => {
    expect(computeWindow({ kind: 'fixed', days: 7 }, day(2), NOW)).toEqual({
      start: day(7),
      end: NOW,
    });
  });
  it('since-last-send starts at the last window end', () => {
    expect(computeWindow({ kind: 'since_last_send', fallbackDays: 7 }, day(3), NOW)).toEqual({
      start: day(3),
      end: NOW,
    });
  });
  it('falls back when there is no watermark', () => {
    expect(computeWindow({ kind: 'since_last_send', fallbackDays: 10 }, null, NOW)).toEqual({
      start: day(10),
      end: NOW,
    });
  });
  it('never starts more than 31 days back', () => {
    expect(computeWindow({ kind: 'since_last_send', fallbackDays: 7 }, day(90), NOW).start).toEqual(
      day(31)
    );
  });
  it('never starts after now', () => {
    expect(
      computeWindow(
        { kind: 'since_last_send', fallbackDays: 7 },
        new Date(NOW.getTime() + 60_000),
        NOW
      ).start
    ).toEqual(NOW);
  });
});
