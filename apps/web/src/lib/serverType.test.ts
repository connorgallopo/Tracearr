import { describe, it, expect } from 'vitest';
import { isJellyfinEmby } from './serverType';

describe('isJellyfinEmby', () => {
  it.each([
    ['plex', false],
    ['jellyfin', true],
    ['emby', true],
  ] as const)('%s is %s', (type, expected) => {
    expect(isJellyfinEmby(type)).toBe(expected);
  });
});
