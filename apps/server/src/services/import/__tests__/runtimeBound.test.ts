import { describe, it, expect } from 'vitest';
import { exceedsRuntime, RUNTIME_SLACK_MS } from '../runtimeBound.js';

describe('exceedsRuntime', () => {
  it('refuses a play one millisecond past the runtime plus slack and keeps one exactly on it', () => {
    expect(exceedsRuntime(5_400_000 + RUNTIME_SLACK_MS + 1, 5_400_000)).toBe(true);
    expect(exceedsRuntime(5_400_000 + RUNTIME_SLACK_MS, 5_400_000)).toBe(false);
  });

  it('never refuses without a runtime', () => {
    expect(exceedsRuntime(999_999_999, null)).toBe(false);
    expect(exceedsRuntime(999_999_999, undefined)).toBe(false);
    expect(exceedsRuntime(999_999_999, 0)).toBe(false);
  });
});
