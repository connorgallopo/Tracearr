import { describe, expect, it } from 'vitest';
import { usernameAsEmail } from '@tracearr/shared';
import { emailFromServer, hasSsePlugin } from '../byServerType.js';

describe('byServerType', () => {
  it('only jellyfin and emby have the sse plugin', () => {
    expect(hasSsePlugin('plex')).toBe(false);
    expect(hasSsePlugin('jellyfin')).toBe(true);
    expect(hasSsePlugin('emby')).toBe(true);
  });

  it('reads email from plex and derives it from the username elsewhere', () => {
    expect(emailFromServer('plex', { username: 'a', email: 'a@b.c' })).toBe('a@b.c');
    expect(emailFromServer('emby', { username: 'a@b.c', email: null })).toBe(
      usernameAsEmail('a@b.c')
    );
  });
});
