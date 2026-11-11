import { describe, expect, it } from 'vitest';
import {
  buildCompositeKey,
  canTerminate,
  pendingKeyFromTrackingKey,
  pendingSessionKey,
  terminationSessionId,
} from '../sessionIdentity.js';

describe('buildCompositeKey', () => {
  describe('JF/Emby servers', () => {
    it('builds key from userId, deviceId, and ratingKey', () => {
      expect(
        buildCompositeKey({
          serverType: 'jellyfin',
          serverId: 'server-1',
          externalUserId: 'user-abc',
          deviceId: 'device-xyz',
          ratingKey: 'media-123',
          sessionKey: 'session-id-456',
        })
      ).toBe('server-1:user-abc:device-xyz:media-123');
    });

    it('falls back to sessionKey when deviceId is empty', () => {
      expect(
        buildCompositeKey({
          serverType: 'jellyfin',
          serverId: 'server-1',
          externalUserId: 'user-abc',
          deviceId: '',
          ratingKey: 'media-123',
          sessionKey: 'session-id-456',
        })
      ).toBe('server-1:user-abc:session-id-456:media-123');
    });

    it('falls back to sessionKey when deviceId is null', () => {
      expect(
        buildCompositeKey({
          serverType: 'emby',
          serverId: 'server-1',
          externalUserId: 'user-abc',
          deviceId: null,
          ratingKey: 'media-123',
          sessionKey: 'session-id-456',
        })
      ).toBe('server-1:user-abc:session-id-456:media-123');
    });

    it('works for emby server type', () => {
      expect(
        buildCompositeKey({
          serverType: 'emby',
          serverId: 'server-2',
          externalUserId: 'user-def',
          deviceId: 'device-abc',
          ratingKey: 'media-789',
          sessionKey: 'session-id-000',
        })
      ).toBe('server-2:user-def:device-abc:media-789');
    });

    it('handles null ratingKey', () => {
      expect(
        buildCompositeKey({
          serverType: 'jellyfin',
          serverId: 'server-1',
          externalUserId: 'user-abc',
          deviceId: 'device-xyz',
          ratingKey: null,
          sessionKey: 'session-id',
        })
      ).toBe('server-1:user-abc:device-xyz:');
    });
  });

  describe('Plex servers', () => {
    it('uses serverId:sessionKey format', () => {
      expect(
        buildCompositeKey({
          serverType: 'plex',
          serverId: 'server-3',
          externalUserId: 'user-ghi',
          deviceId: 'device-plex',
          ratingKey: 'media-456',
          sessionKey: 'plex-session-key',
        })
      ).toBe('server-3:plex-session-key');
    });
  });
});

describe('canTerminate', () => {
  it('plex can terminate only with a session id; jellyfin and emby always can', () => {
    expect(canTerminate('plex', null)).toBe(false);
    expect(canTerminate('plex', undefined)).toBe(false);
    expect(canTerminate('plex', 'abc')).toBe(true);
    expect(canTerminate('jellyfin', null)).toBe(true);
    expect(canTerminate('emby', null)).toBe(true);
  });
});

describe('terminationSessionId', () => {
  it('uses the plex session id on plex and the session key on jellyfin and emby', () => {
    const session = { plexSessionId: 'plex-id', sessionKey: 'sess' };
    expect(terminationSessionId('plex', session)).toBe('plex-id');
    expect(terminationSessionId('plex', { ...session, plexSessionId: null })).toBeNull();
    expect(terminationSessionId('jellyfin', session)).toBe('sess');
    expect(terminationSessionId('emby', session)).toBe('sess');
  });
});

describe('pending keys', () => {
  it('pending key is the session key on plex and the tracking key otherwise', () => {
    expect(pendingSessionKey('plex', 's1:42', '42')).toBe('42');
    expect(pendingSessionKey('emby', 's1:u:d:r', 'sess')).toBe('s1:u:d:r');
  });

  it('recovers the pending key from a tracking key', () => {
    expect(pendingKeyFromTrackingKey('plex', 's1', 's1:42')).toBe('42');
    expect(pendingKeyFromTrackingKey('jellyfin', 's1', 's1:u:d:r')).toBe('s1:u:d:r');
  });
});
