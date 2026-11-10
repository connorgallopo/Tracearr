import { describe, it, expect } from 'vitest';
import { SERVER_TYPES, assertNever, isServerType } from '../index.js';
import { serverTypeSchema } from '../schemas.js';

describe('server types', () => {
  it('keeps the three server types in order', () => {
    expect(SERVER_TYPES).toEqual(['plex', 'jellyfin', 'emby']);
    expect(serverTypeSchema.options).toEqual([...SERVER_TYPES]);
  });

  it('recognizes only the known server types', () => {
    expect(SERVER_TYPES.every(isServerType)).toBe(true);
    expect(isServerType('silo')).toBe(false);
  });

  it('assertNever throws with the value', () => {
    expect(() => assertNever('silo' as never)).toThrow('Unhandled value: silo');
  });
});
