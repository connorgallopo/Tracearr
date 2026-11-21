import { describe, it, expect } from 'vitest';
import { SERVER_PROFILES, SERVER_TYPES } from '@tracearr/shared';
import { addsByApiKey, holdsApiKey, isJellyfinEmby } from './serverType';

describe('isJellyfinEmby', () => {
  it.each([
    ['plex', false],
    ['jellyfin', true],
    ['emby', true],
    ['tofa', false],
    ['silo', false],
  ] as const)('%s is %s', (type, expected) => {
    expect(isJellyfinEmby(type)).toBe(expected);
  });
});

describe('addsByApiKey', () => {
  it.each(SERVER_TYPES)('%s agrees with its profile', (type) => {
    expect(addsByApiKey(type)).toBe(SERVER_PROFILES[type].addServerAuth === 'apiKey');
  });
});

describe('holdsApiKey', () => {
  it.each([
    ['plex', false],
    ['jellyfin', true],
    ['emby', true],
    ['tofa', true],
    ['silo', true],
  ] as const)('%s is %s', (type, expected) => {
    expect(holdsApiKey(type)).toBe(expected);
  });
});
