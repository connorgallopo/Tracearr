/**
 * Parsing Utility Tests
 *
 * Tests the ACTUAL exported functions from parsing.ts:
 * - parseString / parseOptionalString / parseStringOrNull
 * - parseNumber / parseOptionalNumber / parseNumberOrEmpty
 * - parseBoolean / parseOptionalBoolean
 * - parseArray / parseFilteredArray / parseFirstArrayElement
 * - getNestedObject / getNestedValue
 * - parseDate / parseDateString
 * - parse (convenience object)
 *
 * These tests validate:
 * - Correct type coercion for various inputs
 * - Default value handling
 * - null/undefined handling
 * - Edge cases (empty strings, NaN, invalid dates)
 * - Real-world API response patterns from Plex/Jellyfin/Tautulli
 */

import { describe, it, expect } from 'vitest';

// Import ACTUAL production functions - not local duplicates
import {
  parseString,
  parseOptionalString,
  parseStringOrNull,
  parseNumber,
  parseOptionalNumber,
  parseNumberOrEmpty,
  parseBoolean,
  parseOptionalBoolean,
  parseArray,
  parseFilteredArray,
  parseFirstArrayElement,
  getNestedObject,
  getNestedValue,
  parseDate,
  parseDateString,
  parse,
} from '../parsing.js';

describe('parseString', () => {
  it('should convert values to string', () => {
    expect(parseString('hello')).toBe('hello');
    expect(parseString(123)).toBe('123');
    expect(parseString(true)).toBe('true');
    expect(parseString(0)).toBe('0');
  });

  it('should return default for null/undefined', () => {
    expect(parseString(null)).toBe('');
    expect(parseString(undefined)).toBe('');
  });

  it('should use custom default value', () => {
    expect(parseString(null, 'default')).toBe('default');
    expect(parseString(undefined, 'unknown')).toBe('unknown');
  });

  it('should handle empty string as valid value', () => {
    expect(parseString('')).toBe('');
  });

  it('should handle objects (converts to [object Object])', () => {
    expect(parseString({})).toBe('[object Object]');
  });
});

describe('parseOptionalString', () => {
  it('should convert values to string', () => {
    expect(parseOptionalString('hello')).toBe('hello');
    expect(parseOptionalString(123)).toBe('123');
  });

  it('should return undefined for null/undefined', () => {
    expect(parseOptionalString(null)).toBeUndefined();
    expect(parseOptionalString(undefined)).toBeUndefined();
  });

  it('should handle empty string as valid value', () => {
    expect(parseOptionalString('')).toBe('');
  });
});

describe('parseStringOrNull', () => {
  it('should convert values to string', () => {
    expect(parseStringOrNull('hello')).toBe('hello');
    expect(parseStringOrNull(123)).toBe('123');
  });

  it('should return null for null/undefined', () => {
    expect(parseStringOrNull(null)).toBeNull();
    expect(parseStringOrNull(undefined)).toBeNull();
  });

  it('should handle empty string as valid value', () => {
    expect(parseStringOrNull('')).toBe('');
  });
});

describe('parseNumber', () => {
  it('should convert numeric values', () => {
    expect(parseNumber(123)).toBe(123);
    expect(parseNumber('456')).toBe(456);
    expect(parseNumber(3.14)).toBe(3.14);
    expect(parseNumber('3.14')).toBe(3.14);
  });

  it('should return default for null/undefined', () => {
    expect(parseNumber(null)).toBe(0);
    expect(parseNumber(undefined)).toBe(0);
  });

  it('should return default for NaN', () => {
    expect(parseNumber('invalid')).toBe(0);
    expect(parseNumber(NaN)).toBe(0);
  });

  it('should use custom default value', () => {
    expect(parseNumber(null, -1)).toBe(-1);
    expect(parseNumber('invalid', 100)).toBe(100);
  });

  it('should handle zero as valid value', () => {
    expect(parseNumber(0)).toBe(0);
    expect(parseNumber('0')).toBe(0);
  });

  it('should handle negative numbers', () => {
    expect(parseNumber(-5)).toBe(-5);
    expect(parseNumber('-10')).toBe(-10);
  });
});

describe('parseOptionalNumber', () => {
  it('should convert numeric values', () => {
    expect(parseOptionalNumber(123)).toBe(123);
    expect(parseOptionalNumber('456')).toBe(456);
  });

  it('should return undefined for null/undefined', () => {
    expect(parseOptionalNumber(null)).toBeUndefined();
    expect(parseOptionalNumber(undefined)).toBeUndefined();
  });

  it('should return undefined for NaN', () => {
    expect(parseOptionalNumber('invalid')).toBeUndefined();
    expect(parseOptionalNumber(NaN)).toBeUndefined();
  });

  it('should handle zero as valid value', () => {
    expect(parseOptionalNumber(0)).toBe(0);
  });
});

describe('parseNumberOrEmpty', () => {
  it('should convert numeric values', () => {
    expect(parseNumberOrEmpty(123)).toBe(123);
    expect(parseNumberOrEmpty('456')).toBe(456);
  });

  it('should return null for empty string (Tautulli pattern)', () => {
    expect(parseNumberOrEmpty('')).toBeNull();
  });

  it('should return null for null/undefined', () => {
    expect(parseNumberOrEmpty(null)).toBeNull();
    expect(parseNumberOrEmpty(undefined)).toBeNull();
  });

  it('should return null for invalid numbers', () => {
    expect(parseNumberOrEmpty('invalid')).toBeNull();
    expect(parseNumberOrEmpty(NaN)).toBeNull();
  });

  it('should handle zero as valid value', () => {
    expect(parseNumberOrEmpty(0)).toBe(0);
    expect(parseNumberOrEmpty('0')).toBe(0);
  });

  // Real Tautulli API patterns
  it('should handle Tautulli year field (number for movies, "" for episodes)', () => {
    expect(parseNumberOrEmpty(2024)).toBe(2024); // Movie
    expect(parseNumberOrEmpty('')).toBeNull(); // Episode
  });

  it('should handle Tautulli media_index field', () => {
    expect(parseNumberOrEmpty(5)).toBe(5); // Episode number
    expect(parseNumberOrEmpty('')).toBeNull(); // Movie
  });
});

describe('parseBoolean', () => {
  it('should convert truthy values', () => {
    expect(parseBoolean(true)).toBe(true);
    expect(parseBoolean(1)).toBe(true);
    expect(parseBoolean('true')).toBe(true);
    expect(parseBoolean('anything')).toBe(true);
  });

  it('should convert falsy values', () => {
    expect(parseBoolean(false)).toBe(false);
    expect(parseBoolean(0)).toBe(false);
    expect(parseBoolean('')).toBe(false);
  });

  it('should return default for null/undefined', () => {
    expect(parseBoolean(null)).toBe(false);
    expect(parseBoolean(undefined)).toBe(false);
  });

  it('should use custom default value', () => {
    expect(parseBoolean(null, true)).toBe(true);
    expect(parseBoolean(undefined, true)).toBe(true);
  });
});

describe('parseOptionalBoolean', () => {
  it('should convert values to boolean', () => {
    expect(parseOptionalBoolean(true)).toBe(true);
    expect(parseOptionalBoolean(false)).toBe(false);
    expect(parseOptionalBoolean(1)).toBe(true);
    expect(parseOptionalBoolean(0)).toBe(false);
  });

  it('should return undefined for null/undefined', () => {
    expect(parseOptionalBoolean(null)).toBeUndefined();
    expect(parseOptionalBoolean(undefined)).toBeUndefined();
  });
});

describe('parseArray', () => {
  it('should map array elements', () => {
    const input = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = parseArray(input, (item) => (item as { id: number }).id);

    expect(result).toEqual([1, 2, 3]);
  });

  it('should return empty array for non-array', () => {
    expect(parseArray(null, (x) => x)).toEqual([]);
    expect(parseArray(undefined, (x) => x)).toEqual([]);
    expect(parseArray('string', (x) => x)).toEqual([]);
    expect(parseArray({}, (x) => x)).toEqual([]);
  });

  it('should handle empty array', () => {
    expect(parseArray([], (x) => x)).toEqual([]);
  });

  it('should pass index to mapper', () => {
    const input = ['a', 'b', 'c'];
    const result = parseArray(input, (item, index) => `${item}-${index}`);

    expect(result).toEqual(['a-0', 'b-1', 'c-2']);
  });
});

describe('parseFilteredArray', () => {
  it('should filter and map array elements', () => {
    const input = [
      { id: 1, active: true },
      { id: 2, active: false },
      { id: 3, active: true },
    ];
    const result = parseFilteredArray(
      input,
      (item) => (item as { active: boolean }).active,
      (item) => (item as { id: number }).id
    );

    expect(result).toEqual([1, 3]);
  });

  it('should return empty array for non-array', () => {
    expect(
      parseFilteredArray(
        null,
        () => true,
        (x) => x
      )
    ).toEqual([]);
  });

  // Real Jellyfin pattern: filter sessions with NowPlayingItem
  it('should handle Jellyfin session filtering pattern', () => {
    const sessions = [
      { Id: '1', NowPlayingItem: { Name: 'Movie' } },
      { Id: '2', NowPlayingItem: null },
      { Id: '3', NowPlayingItem: { Name: 'Show' } },
    ];

    const result = parseFilteredArray(
      sessions,
      (s) => (s as { NowPlayingItem: unknown }).NowPlayingItem != null,
      (s) => (s as { Id: string }).Id
    );

    expect(result).toEqual(['1', '3']);
  });
});

describe('parseFirstArrayElement', () => {
  it('should get property from first array element', () => {
    const media = [{ bitrate: 8000000 }, { bitrate: 4000000 }];
    expect(parseFirstArrayElement(media, 'bitrate')).toBe(8000000);
  });

  it('should return default for empty array', () => {
    expect(parseFirstArrayElement([], 'bitrate', 0)).toBe(0);
    expect(parseFirstArrayElement([], 'bitrate')).toBeUndefined();
  });

  it('should return default for non-array', () => {
    expect(parseFirstArrayElement(null, 'bitrate', 0)).toBe(0);
    expect(parseFirstArrayElement(undefined, 'bitrate', 0)).toBe(0);
    expect(parseFirstArrayElement('string', 'bitrate', 0)).toBe(0);
  });

  it('should return default when property not found', () => {
    const media = [{ other: 'value' }];
    expect(parseFirstArrayElement(media, 'bitrate', 0)).toBe(0);
  });

  it('should return undefined when property is undefined', () => {
    const media = [{ bitrate: undefined }];
    expect(parseFirstArrayElement(media, 'bitrate', 0)).toBe(0);
  });

  it('should return default when first element is null', () => {
    const media = [null, { bitrate: 8000000 }];
    expect(parseFirstArrayElement(media, 'bitrate', 0)).toBe(0);
  });

  it('should return default when first element is not an object', () => {
    const media = ['string', { bitrate: 8000000 }];
    expect(parseFirstArrayElement(media, 'bitrate', 0)).toBe(0);
  });

  // Real Plex pattern: (item.Media as Record<string, unknown>[])?.[0]?.bitrate
  it('should handle Plex Media array pattern', () => {
    const item = {
      Media: [{ bitrate: 10000000, videoResolution: '1080' }],
    };
    expect(parseFirstArrayElement(item.Media, 'bitrate')).toBe(10000000);
    expect(parseFirstArrayElement(item.Media, 'videoResolution')).toBe('1080');
  });

  // Real Jellyfin pattern: mediaSources?.[0]?.bitrate
  it('should handle Jellyfin MediaSources pattern', () => {
    const nowPlaying = {
      mediaSources: [{ Bitrate: 5000000 }],
    };
    expect(parseFirstArrayElement(nowPlaying.mediaSources, 'Bitrate')).toBe(5000000);
  });
});

describe('getNestedObject', () => {
  it('should get nested object', () => {
    const user = { Policy: { IsAdministrator: true } };
    const policy = getNestedObject(user, 'Policy');

    expect(policy).toEqual({ IsAdministrator: true });
  });

  it('should return undefined for missing key', () => {
    const user = { Name: 'Test' };
    expect(getNestedObject(user, 'Policy')).toBeUndefined();
  });

  it('should return undefined for null/undefined input', () => {
    expect(getNestedObject(null, 'Policy')).toBeUndefined();
    expect(getNestedObject(undefined, 'Policy')).toBeUndefined();
  });

  it('should return undefined for non-object value', () => {
    const user = { Policy: 'string' };
    expect(getNestedObject(user, 'Policy')).toBeUndefined();
  });
});

describe('getNestedValue', () => {
  it('should get deeply nested value', () => {
    const data = { a: { b: { c: 'value' } } };
    expect(getNestedValue(data, 'a', 'b', 'c')).toBe('value');
  });

  it('should return undefined for missing path', () => {
    const data = { a: { b: 1 } };
    expect(getNestedValue(data, 'a', 'b', 'c')).toBeUndefined();
    expect(getNestedValue(data, 'x')).toBeUndefined();
  });

  it('should return undefined for null in path', () => {
    const data = { a: null };
    expect(getNestedValue(data, 'a', 'b')).toBeUndefined();
  });

  // Real Jellyfin pattern: (session.PlayState as Record<string, unknown>).PositionTicks
  it('should handle Jellyfin PlayState.PositionTicks pattern', () => {
    const session = {
      PlayState: { PositionTicks: 1234567890, IsPaused: false },
    };
    expect(getNestedValue(session, 'PlayState', 'PositionTicks')).toBe(1234567890);
    expect(getNestedValue(session, 'PlayState', 'IsPaused')).toBe(false);
  });

  // Real Jellyfin pattern: (user.Policy as Record<string, unknown>)?.IsAdministrator
  it('should handle Jellyfin user.Policy.IsAdministrator pattern', () => {
    const user = {
      Policy: { IsAdministrator: true, IsDisabled: false },
    };
    expect(getNestedValue(user, 'Policy', 'IsAdministrator')).toBe(true);
    expect(getNestedValue(user, 'Policy', 'IsDisabled')).toBe(false);
  });
});

describe('parseDate', () => {
  it('should parse valid ISO date string', () => {
    const date = parseDate('2024-01-15T10:30:00.000Z');
    expect(date).toBeInstanceOf(Date);
    expect(date?.toISOString()).toBe('2024-01-15T10:30:00.000Z');
  });

  it('should parse various date formats', () => {
    expect(parseDate('2024-01-15')).toBeInstanceOf(Date);
    expect(parseDate('January 15, 2024')).toBeInstanceOf(Date);
  });

  it('should return null for null/undefined', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });

  it('should return null for invalid date', () => {
    expect(parseDate('not-a-date')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
});

describe('parseDateString', () => {
  it('should parse and return ISO string', () => {
    const result = parseDateString('2024-01-15T10:30:00.000Z');
    expect(result).toBe('2024-01-15T10:30:00.000Z');
  });

  it('should normalize date to ISO string', () => {
    const result = parseDateString('2024-01-15');
    expect(result).toMatch(/^2024-01-15T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it('should return null for null/undefined', () => {
    expect(parseDateString(null)).toBeNull();
    expect(parseDateString(undefined)).toBeNull();
  });

  it('should return null for invalid date', () => {
    expect(parseDateString('invalid')).toBeNull();
  });
});

describe('parse convenience object', () => {
  it('should have all parsing functions', () => {
    expect(parse.string).toBe(parseString);
    expect(parse.optionalString).toBe(parseOptionalString);
    expect(parse.stringOrNull).toBe(parseStringOrNull);
    expect(parse.number).toBe(parseNumber);
    expect(parse.optionalNumber).toBe(parseOptionalNumber);
    expect(parse.numberOrEmpty).toBe(parseNumberOrEmpty);
    expect(parse.boolean).toBe(parseBoolean);
    expect(parse.optionalBoolean).toBe(parseOptionalBoolean);
    expect(parse.array).toBe(parseArray);
    expect(parse.filteredArray).toBe(parseFilteredArray);
    expect(parse.firstArrayElement).toBe(parseFirstArrayElement);
    expect(parse.nested).toBe(getNestedObject);
    expect(parse.nestedValue).toBe(getNestedValue);
    expect(parse.date).toBe(parseDate);
    expect(parse.dateString).toBe(parseDateString);
  });

  // Real-world usage example
  it('should work with real Jellyfin session parsing pattern', () => {
    const rawSession = {
      Id: 'session-123',
      UserId: 'user-456',
      UserName: 'testuser',
      Client: 'Jellyfin Web',
      DeviceName: 'Chrome',
      NowPlayingItem: {
        Id: 'item-789',
        Name: 'Test Movie',
        Type: 'Movie',
        RunTimeTicks: 72000000000,
        ProductionYear: 2024,
      },
      PlayState: {
        PositionTicks: 36000000000,
        IsPaused: false,
      },
    };

    const parsed = {
      id: parse.string(rawSession.Id),
      userId: parse.string(rawSession.UserId),
      userName: parse.string(rawSession.UserName),
      client: parse.string(rawSession.Client),
      deviceName: parse.string(rawSession.DeviceName),
      nowPlayingItem: rawSession.NowPlayingItem
        ? {
            id: parse.string(rawSession.NowPlayingItem.Id),
            name: parse.string(rawSession.NowPlayingItem.Name),
            type: parse.string(rawSession.NowPlayingItem.Type),
            runTimeTicks: parse.number(rawSession.NowPlayingItem.RunTimeTicks),
            productionYear: parse.optionalNumber(rawSession.NowPlayingItem.ProductionYear),
          }
        : undefined,
      playState: rawSession.PlayState
        ? {
            positionTicks: parse.number(
              parse.nestedValue(rawSession, 'PlayState', 'PositionTicks')
            ),
            isPaused: parse.boolean(parse.nestedValue(rawSession, 'PlayState', 'IsPaused')),
          }
        : undefined,
    };

    expect(parsed.id).toBe('session-123');
    expect(parsed.nowPlayingItem?.runTimeTicks).toBe(72000000000);
    expect(parsed.playState?.isPaused).toBe(false);
  });

  // Real-world usage example for Plex
  it('should work with real Plex session parsing pattern', () => {
    const rawItem = {
      sessionKey: '12345',
      ratingKey: '67890',
      title: 'Test Movie',
      type: 'movie',
      duration: 7200000,
      viewOffset: 3600000,
      year: 2024,
      Player: {
        title: 'Plex Web',
        state: 'playing',
        local: false,
      },
      Media: [{ bitrate: 8000000 }],
    };

    const parsed = {
      sessionKey: parse.string(rawItem.sessionKey),
      title: parse.string(rawItem.title),
      duration: parse.number(rawItem.duration),
      year: parse.number(rawItem.year),
      playerTitle: parse.string(parse.nestedValue(rawItem, 'Player', 'title')),
      playerState: parse.string(parse.nestedValue(rawItem, 'Player', 'state')),
      isLocal: parse.boolean(parse.nestedValue(rawItem, 'Player', 'local')),
      bitrate: parse.number(parse.firstArrayElement(rawItem.Media, 'bitrate', 0)),
    };

    expect(parsed.sessionKey).toBe('12345');
    expect(parsed.duration).toBe(7200000);
    expect(parsed.playerTitle).toBe('Plex Web');
    expect(parsed.isLocal).toBe(false);
    expect(parsed.bitrate).toBe(8000000);
  });
});
