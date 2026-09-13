import { describe, expect, it } from 'vitest';
import { rankMergeTarget, type MergeRankInput } from '../index.js';

const identity = (over: Partial<MergeRankInput> & { userId: string }): MergeRankInput => ({
  loginCapable: false,
  removed: false,
  lastActivityAt: null,
  sessionCount: 0,
  ...over,
});

describe('rankMergeTarget', () => {
  it('keeps login over a live account, a live account over recent activity, and activity over sessions', () => {
    const a = identity({ userId: 'a', loginCapable: true, removed: true });
    const b = identity({
      userId: 'b',
      lastActivityAt: '2026-09-01T00:00:00.000Z',
      sessionCount: 9,
    });
    expect(rankMergeTarget(a, b)).toBe('a');

    const removed = identity({
      userId: 'old',
      removed: true,
      lastActivityAt: '2026-09-10T00:00:00.000Z',
    });
    const live = identity({ userId: 'new', lastActivityAt: '2025-01-01T00:00:00.000Z' });
    expect(rankMergeTarget(removed, live)).toBe('new');

    const recent = identity({ userId: 'recent', lastActivityAt: '2026-09-10T00:00:00.000Z' });
    const busy = identity({
      userId: 'busy',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      sessionCount: 400,
    });
    expect(rankMergeTarget(busy, recent)).toBe('recent');

    expect(
      rankMergeTarget(
        identity({ userId: 'x', sessionCount: 1 }),
        identity({ userId: 'y', sessionCount: 3 })
      )
    ).toBe('y');
  });

  it('keeps the first on a full tie', () => {
    expect(rankMergeTarget(identity({ userId: 'first' }), identity({ userId: 'second' }))).toBe(
      'first'
    );
  });
});
