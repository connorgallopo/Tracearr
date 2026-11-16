import { describe, expect, it } from 'vitest';
import { getAvatarUrl } from './utils';

describe('getAvatarUrl', () => {
  it('gives no avatar for an absolute address on an unknown host', () => {
    expect(getAvatarUrl('server-1', 'https://cdn.example.com/a.png')).toBeNull();
  });

  it('loads a plex.tv avatar directly and proxies a tofa upload', () => {
    expect(getAvatarUrl('server-1', 'https://plex.tv/users/x/avatar')).toBe(
      'https://plex.tv/users/x/avatar'
    );
    expect(getAvatarUrl('server-1', 'https://api.tofa.tv/avatars/a.png')).toContain(
      '/images/proxy'
    );
  });
});
