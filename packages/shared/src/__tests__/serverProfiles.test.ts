import { describe, it, expect } from 'vitest';
import { SERVER_PROFILES, SERVER_TYPES, liveStatsGapSeconds } from '../index.js';

describe('server profiles', () => {
  it('has a profile for every server type', () => {
    expect(Object.keys(SERVER_PROFILES).sort()).toEqual([...SERVER_TYPES].sort());
  });

  it('plex identifies sessions by session key, jellyfin and emby by composite', () => {
    expect(SERVER_PROFILES.plex.sessionIdentity).toBe('sessionKey');
    expect(SERVER_PROFILES.jellyfin.sessionIdentity).toBe('composite');
    expect(SERVER_PROFILES.emby.sessionIdentity).toBe('composite');
    expect(SERVER_PROFILES.tofa.sessionIdentity).toBe('sessionKey');
  });

  it('names each server the way the product writes it', () => {
    expect(SERVER_TYPES.map((type) => SERVER_PROFILES[type].displayName)).toEqual([
      'Plex',
      'Jellyfin',
      'Emby',
      'tofa',
    ]);
  });

  it('bridges tofa across its idle samples and breaks the others after 15 seconds', () => {
    expect(SERVER_TYPES.map(liveStatsGapSeconds)).toEqual([15, 15, 15, 35]);
  });

  it('only tofa counts a play as watched by its own rule', () => {
    expect(SERVER_PROFILES.tofa.watchedThreshold).toBe('serverRule');
    expect(SERVER_PROFILES.plex.watchedThreshold).toBe('tracearrSetting');
    expect(SERVER_PROFILES.jellyfin.watchedThreshold).toBe('tracearrSetting');
    expect(SERVER_PROFILES.emby.watchedThreshold).toBe('tracearrSetting');
  });

  it.each([
    ['plex', 'plexWebsocket', 'plexStatistics', 'server', false],
    ['jellyfin', 'ssePlugin', 'ssePlugin', 'username', true],
    ['emby', 'ssePlugin', 'ssePlugin', 'username', true],
    ['tofa', 'tofaSocket', 'tofaMetrics', 'server', true],
  ] as const)('%s', (type, liveEvents, hostStats, emailSource, playerName) => {
    expect(SERVER_PROFILES[type]).toMatchObject({
      liveEvents,
      hostStats,
      emailSource,
      playerNameCountsTowardDevice: playerName,
    });
  });

  it.each([
    ['plex', 'plexSessionId', false, true],
    ['jellyfin', 'sessionKey', true, false],
    ['emby', 'sessionKey', true, false],
    ['tofa', 'sessionKey', false, false],
  ] as const)(
    '%s terminates, identifies its install and links history',
    (type, terminatesBy, userIds, links) => {
      expect(SERVER_PROFILES[type]).toMatchObject({
        terminatesBy,
        userIdsIdentifyInstall: userIds,
        linksImportedHistory: links,
      });
    }
  );

  it.each([
    ['plex', 'plexOAuth', 'plexTv', true, true, true, null],
    ['jellyfin', 'apiKey', 'serverPassword', false, false, false, null],
    ['emby', 'apiKey', 'serverPassword', false, false, false, null],
    ['tofa', 'tofaCloud', 'tofaCloud', false, false, false, 'tofa'],
  ] as const)(
    '%s adds, signs in, reports bandwidth and bitrates, and imports history',
    (type, addServerAuth, memberSignIn, bandwidth, trackBitrates, tautulli, serverHistory) => {
      expect(SERVER_PROFILES[type]).toMatchObject({
        addServerAuth,
        memberSignIn,
        reportsBandwidth: bandwidth,
        reportsTranscodeTrackBitrates: trackBitrates,
        importsTautulliHistory: tautulli,
        serverHistoryImport: serverHistory,
      });
    }
  );
});
