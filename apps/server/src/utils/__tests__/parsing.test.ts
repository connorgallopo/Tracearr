/**
 * Unit tests for parsing utilities
 *
 * Tests parseBoundedString and parseOptionalBoundedString functions
 * used for DB varchar column length validation.
 */

import { describe, it, expect } from 'vitest';
import { parseBoundedString, parseOptionalBoundedString } from '../parsing.js';

describe('parseBoundedString', () => {
  it('returns empty string for null', () => {
    expect(parseBoundedString(null, 10)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(parseBoundedString(undefined, 10)).toBe('');
  });

  it('returns custom default for null/undefined', () => {
    expect(parseBoundedString(null, 10, 'default')).toBe('default');
    expect(parseBoundedString(undefined, 10, 'fallback')).toBe('fallback');
  });

  it('returns string unchanged when under limit', () => {
    expect(parseBoundedString('short', 10)).toBe('short');
    expect(parseBoundedString('exactly10!', 10)).toBe('exactly10!');
  });

  it('truncates string when over limit', () => {
    expect(parseBoundedString('this is too long', 10)).toBe('this is to');
    expect(parseBoundedString('abcdefghijk', 5)).toBe('abcde');
  });

  it('converts numbers to strings', () => {
    expect(parseBoundedString(12345, 3)).toBe('123');
    expect(parseBoundedString(42, 10)).toBe('42');
  });

  it('handles empty string', () => {
    expect(parseBoundedString('', 10)).toBe('');
  });

  it('handles zero maxLength', () => {
    expect(parseBoundedString('anything', 0)).toBe('');
  });

  it('truncates at exact boundary', () => {
    expect(parseBoundedString('12345', 5)).toBe('12345');
    expect(parseBoundedString('123456', 5)).toBe('12345');
  });

  it('handles unicode characters', () => {
    // Note: slice counts UTF-16 code units, not graphemes
    expect(parseBoundedString('Hello World', 5)).toBe('Hello');
  });

  // Edge cases for DB column safety
  describe('edge cases', () => {
    it('handles very long strings efficiently', () => {
      const longString = 'x'.repeat(10000);
      expect(parseBoundedString(longString, 255)).toHaveLength(255);
      expect(parseBoundedString(longString, 100)).toHaveLength(100);
    });

    it('handles multi-byte unicode (emojis)', () => {
      // Emojis are 2 UTF-16 code units each
      const emoji = '😀😀😀';
      expect(parseBoundedString(emoji, 2).length).toBeLessThanOrEqual(2);
    });

    it('handles CJK characters', () => {
      const cjk = '中文字符测试';
      expect(parseBoundedString(cjk, 3)).toBe('中文字');
    });

    it('handles boolean inputs', () => {
      expect(parseBoundedString(true, 10)).toBe('true');
      expect(parseBoundedString(false, 10)).toBe('false');
    });

    it('handles object inputs', () => {
      expect(parseBoundedString({}, 20)).toBe('[object Object]');
      expect(parseBoundedString({ a: 1 }, 5)).toBe('[obje');
    });

    it('handles common DB varchar limits', () => {
      const text = 'A'.repeat(300);
      expect(parseBoundedString(text, 255)).toHaveLength(255); // varchar(255)
      expect(parseBoundedString(text, 100)).toHaveLength(100); // varchar(100)
      expect(parseBoundedString(text, 500)).toHaveLength(300); // varchar(500) - no truncation
    });

    it('preserves leading/trailing whitespace within limit', () => {
      expect(parseBoundedString('  text  ', 10)).toBe('  text  ');
      expect(parseBoundedString('  text  ', 5)).toBe('  tex');
    });

    it('default truncates within limit', () => {
      expect(parseBoundedString(null, 5, 'default-value')).toBe('defau');
    });
  });
});

describe('parseOptionalBoundedString', () => {
  it('returns undefined for null', () => {
    expect(parseOptionalBoundedString(null, 10)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseOptionalBoundedString(undefined, 10)).toBeUndefined();
  });

  it('returns string unchanged when under limit', () => {
    expect(parseOptionalBoundedString('short', 10)).toBe('short');
    expect(parseOptionalBoundedString('exactly10!', 10)).toBe('exactly10!');
  });

  it('truncates string when over limit', () => {
    expect(parseOptionalBoundedString('this is too long', 10)).toBe('this is to');
    expect(parseOptionalBoundedString('abcdefghijk', 5)).toBe('abcde');
  });

  it('converts numbers to strings', () => {
    expect(parseOptionalBoundedString(12345, 3)).toBe('123');
    expect(parseOptionalBoundedString(42, 10)).toBe('42');
  });

  it('returns empty string for empty string input (not undefined)', () => {
    expect(parseOptionalBoundedString('', 10)).toBe('');
  });

  it('handles zero maxLength', () => {
    expect(parseOptionalBoundedString('anything', 0)).toBe('');
  });

  // Edge cases
  describe('edge cases', () => {
    it('handles very long strings efficiently', () => {
      const longString = 'x'.repeat(10000);
      expect(parseOptionalBoundedString(longString, 255)).toHaveLength(255);
    });

    it('handles multi-byte unicode (emojis)', () => {
      const emoji = '😀😀😀';
      const result = parseOptionalBoundedString(emoji, 2);
      expect(result?.length).toBeLessThanOrEqual(2);
    });

    it('handles CJK characters', () => {
      const cjk = '中文字符';
      expect(parseOptionalBoundedString(cjk, 2)).toBe('中文');
    });

    it('handles boolean inputs', () => {
      expect(parseOptionalBoundedString(true, 10)).toBe('true');
      expect(parseOptionalBoundedString(false, 10)).toBe('false');
    });

    it('handles object inputs', () => {
      expect(parseOptionalBoundedString({}, 20)).toBe('[object Object]');
    });
  });
});
