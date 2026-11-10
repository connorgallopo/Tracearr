import type { ServerType } from './serverTypes.js';

export interface ServerProfile {
  /** composite: keyed by user, device and item, because the server's session id changes when a client restarts playback. */
  sessionIdentity: 'sessionKey' | 'composite';
}

export const SERVER_PROFILES: Record<ServerType, ServerProfile> = {
  plex: {
    sessionIdentity: 'sessionKey',
  },
  jellyfin: {
    sessionIdentity: 'composite',
  },
  emby: {
    sessionIdentity: 'composite',
  },
};
