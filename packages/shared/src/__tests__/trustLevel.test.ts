import { describe, expect, it } from 'vitest';
import { trustLevel } from '../trustLevel.js';

describe('trustLevel', () => {
  it('is trusted from 80', () => {
    expect(trustLevel(100)).toBe('trusted');
    expect(trustLevel(80)).toBe('trusted');
  });

  it('is caution from 50 up to 79', () => {
    expect(trustLevel(79)).toBe('caution');
    expect(trustLevel(50)).toBe('caution');
  });

  it('is untrusted below 50', () => {
    expect(trustLevel(49)).toBe('untrusted');
    expect(trustLevel(0)).toBe('untrusted');
  });
});
