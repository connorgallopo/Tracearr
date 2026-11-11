import { describe, expect, it } from 'vitest';
import { usernameAsEmail } from '@tracearr/shared';
import { emailForSessionUser } from '../byServerType.js';

describe('byServerType', () => {
  it('leaves plex email to user sync and derives it from the username elsewhere', () => {
    expect(emailForSessionUser('plex', 'a@b.c')).toBeNull();
    expect(emailForSessionUser('emby', 'a@b.c')).toBe(usernameAsEmail('a@b.c'));
  });
});
