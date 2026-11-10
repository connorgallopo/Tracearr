import { describe, it, expect } from 'vitest';
import { SERVER_PROFILES, SERVER_TYPES } from '../index.js';

describe('server profiles', () => {
  it('has a profile for every server type', () => {
    expect(Object.keys(SERVER_PROFILES).sort()).toEqual([...SERVER_TYPES].sort());
  });

  it('plex identifies sessions by session key, jellyfin and emby by composite', () => {
    expect(SERVER_PROFILES.plex.sessionIdentity).toBe('sessionKey');
    expect(SERVER_PROFILES.jellyfin.sessionIdentity).toBe('composite');
    expect(SERVER_PROFILES.emby.sessionIdentity).toBe('composite');
  });
});
