import { describe, expect, it, vi } from 'vitest';
import { usernameAsEmail } from '@tracearr/shared';

vi.mock('../../settings.js', () => ({
  getWatchedThreshold: vi.fn(async () => 0.85),
}));

import { emailForSessionUser, serverWatchedThreshold, stopRefusal } from '../byServerType.js';

describe('byServerType', () => {
  it('leaves plex email to user sync and derives it from the username elsewhere', () => {
    expect(emailForSessionUser('plex', 'a@b.c')).toBeNull();
    expect(emailForSessionUser('emby', 'a@b.c')).toBe(usernameAsEmail('a@b.c'));
  });

  it("counts a tofa play as watched by tofa's own rule, and by the setting until it is known", async () => {
    expect(await serverWatchedThreshold({ type: 'tofa', watchedRulePercent: 90 }, 'movie')).toBe(
      0.9
    );
    expect(await serverWatchedThreshold({ type: 'tofa', watchedRulePercent: null }, 'movie')).toBe(
      0.85
    );
    expect(await serverWatchedThreshold({ type: 'plex', watchedRulePercent: 90 }, 'movie')).toBe(
      0.85
    );
  });

  it('refuses to stop a stream with a tofa key that may not', () => {
    expect(
      stopRefusal({ sessionKey: 'session-1', server: { type: 'tofa', canStopStreams: false } })
    ).toBe('this tofa API key cannot stop streams');
    expect(
      stopRefusal({ sessionKey: 'session-1', server: { type: 'tofa', canStopStreams: true } })
    ).toBeNull();
    expect(
      stopRefusal({ sessionKey: 'session-1', server: { type: 'plex', canStopStreams: null } })
    ).toBeNull();
  });

  it('refuses to stop a tofa live viewer that has no playback session, whatever the key', () => {
    expect(
      stopRefusal({ sessionKey: 'viewer:viewer-1', server: { type: 'tofa', canStopStreams: true } })
    ).toBe('tofa has no way for Tracearr to stop a live TV viewer without a playback session');
  });
});
