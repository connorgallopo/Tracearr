/**
 * Session Identity
 *
 * How each server type keys a session for tracking, pending confirmation and termination.
 * Pending and kill-cooldown keys built from these outlive a restart or upgrade in Redis,
 * so their format must not change.
 */

import { SERVER_PROFILES, assertNever, type ServerType } from '@tracearr/shared';
import type { BuildCompositeKeyInput } from './types.js';

/**
 * Build a cache/tracking key for a session.
 * Plex: `serverId:sessionKey`. JF/Emby: `serverId:userId:deviceId:ratingKey`.
 */
export function buildCompositeKey(input: BuildCompositeKeyInput): string {
  const { serverType, serverId, externalUserId, deviceId, ratingKey, sessionKey } = input;
  const identity = SERVER_PROFILES[serverType].sessionIdentity;
  switch (identity) {
    case 'sessionKey':
      return `${serverId}:${sessionKey}`;
    case 'composite': {
      const deviceIdentifier = deviceId || sessionKey;
      return `${serverId}:${externalUserId}:${deviceIdentifier}:${ratingKey ?? ''}`;
    }
    default:
      return assertNever(identity);
  }
}

/** Key a pending session is stored under, given its tracking key and the server's session key. */
export function pendingSessionKey(
  type: ServerType,
  trackingKey: string,
  sessionKey: string
): string {
  const identity = SERVER_PROFILES[type].sessionIdentity;
  switch (identity) {
    case 'sessionKey':
      return sessionKey;
    case 'composite':
      return trackingKey;
    default:
      return assertNever(identity);
  }
}

/** Inverse of pendingSessionKey for a tracking key built by buildCompositeKey. */
export function pendingKeyFromTrackingKey(
  type: ServerType,
  serverId: string,
  trackingKey: string
): string {
  const identity = SERVER_PROFILES[type].sessionIdentity;
  switch (identity) {
    case 'sessionKey':
      return trackingKey.slice(serverId.length + 1);
    case 'composite':
      return trackingKey;
    default:
      return assertNever(identity);
  }
}

/** Plex stops a playback by Session.id, which differs from its sessionKey; JF/Emby by the session id stored as sessionKey. */
export function terminationSessionId(
  type: ServerType,
  session: { plexSessionId: string | null; sessionKey: string }
): string | null {
  const identity = SERVER_PROFILES[type].sessionIdentity;
  switch (identity) {
    case 'sessionKey':
      return session.plexSessionId;
    case 'composite':
      return session.sessionKey;
    default:
      return assertNever(identity);
  }
}

/** Some Plex clients (Plexamp) report no Session.id, and Plex cannot stop a playback without one. */
export function canTerminate(type: ServerType, plexSessionId: string | null | undefined): boolean {
  const identity = SERVER_PROFILES[type].sessionIdentity;
  switch (identity) {
    case 'sessionKey':
      return !!plexSessionId;
    case 'composite':
      return true;
    default:
      return assertNever(identity);
  }
}
