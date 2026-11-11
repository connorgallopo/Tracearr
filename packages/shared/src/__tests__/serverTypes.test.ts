import { describe, it, expect } from 'vitest';
import { SERVER_TYPES, assertNever, isServerType } from '../index.js';
import { createServerSchema, serverTypeSchema } from '../schemas.js';

describe('server types', () => {
  it('keeps the three server types in order', () => {
    expect(SERVER_TYPES).toEqual(['plex', 'jellyfin', 'emby']);
    expect(serverTypeSchema.options).toEqual([...SERVER_TYPES]);
  });

  it('recognizes only the known server types', () => {
    expect(SERVER_TYPES.every(isServerType)).toBe(true);
    expect(isServerType('not-a-server')).toBe(false);
  });

  it('assertNever throws with the value', () => {
    expect(() => assertNever('not-a-server' as never)).toThrow('Unhandled value: not-a-server');
  });

  it.each([
    ['plex', false],
    ['jellyfin', true],
    ['emby', true],
  ] as const)('a %s server accepts a public address: %s', (type, accepted) => {
    const server = { name: 'Den', type, url: 'http://10.0.0.2:8096', token: 'key' };
    expect(createServerSchema.safeParse(server).success).toBe(true);
    expect(
      createServerSchema.safeParse({ ...server, publicUrl: 'https://media.example.com' }).success
    ).toBe(accepted);
  });
});
