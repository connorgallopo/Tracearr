import { describe, it, expect } from 'vitest';
import { SERVER_TYPES, assertNever } from '../index.js';
import { serverTypeSchema } from '../schemas.js';

describe('server types', () => {
  it('keeps the three server types in order', () => {
    expect(SERVER_TYPES).toEqual(['plex', 'jellyfin', 'emby']);
    expect(serverTypeSchema.options).toEqual([...SERVER_TYPES]);
  });

  it('assertNever throws with the value', () => {
    expect(() => assertNever('silo' as never)).toThrow('Unhandled value: silo');
  });
});
