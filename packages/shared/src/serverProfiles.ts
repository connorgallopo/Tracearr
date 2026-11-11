import type { ServerType } from './serverTypes.js';

export interface ServerProfile {
  /** composite: keyed by user, device and item, because the server's session id changes when a client restarts playback. */
  sessionIdentity: 'sessionKey' | 'composite';
  /** The id the server needs to stop a playback. */
  terminatesBy: 'plexSessionId' | 'sessionKey';
  /** ssePlugin: needs the Tracearr SSE plugin installed on the server; without it the poller covers the server. */
  liveEvents: 'plexWebsocket' | 'ssePlugin';
  /** Where host CPU and memory come from: Plex's statistics endpoint, or the SSE plugin's stats events. */
  hostStats: 'plexStatistics' | 'ssePlugin';
  /** username: the server reports no email, so an account's email is its username when that is an address. */
  emailSource: 'server' | 'username';
  /** User ids are minted per install, so one shared id proves two addresses reach the same install. */
  userIdsIdentifyInstall: boolean;
  /** The player name is the device name the server reports, not a title the user chose, so it can classify the device. */
  playerNameCountsTowardDevice: boolean;
  /** History imported for this server is linked to library items after a library sync. */
  linksImportedHistory: boolean;
  /** How the owner adds the server: picked from a linked Plex account, or by URL and API key. */
  addServerAuth: 'plexOAuth' | 'apiKey';
  /** How members sign in: through plex.tv, or with their username and password on the server. */
  memberSignIn: 'plexTv' | 'serverPassword';
  /** The server measures its own bandwidth, so the dashboard can chart it. */
  reportsBandwidth: boolean;
  /** A transcode reports separate video and audio bitrates; without them only the total stream bitrate is known. */
  reportsTranscodeTrackBitrates: boolean;
  /** Tautulli tracks this server, so its play history can be imported from Tautulli. */
  importsTautulliHistory: boolean;
}

export const SERVER_PROFILES: Record<ServerType, ServerProfile> = {
  plex: {
    sessionIdentity: 'sessionKey',
    terminatesBy: 'plexSessionId',
    liveEvents: 'plexWebsocket',
    hostStats: 'plexStatistics',
    emailSource: 'server',
    userIdsIdentifyInstall: false,
    playerNameCountsTowardDevice: false,
    linksImportedHistory: true,
    addServerAuth: 'plexOAuth',
    memberSignIn: 'plexTv',
    reportsBandwidth: true,
    reportsTranscodeTrackBitrates: true,
    importsTautulliHistory: true,
  },
  jellyfin: {
    sessionIdentity: 'composite',
    terminatesBy: 'sessionKey',
    liveEvents: 'ssePlugin',
    hostStats: 'ssePlugin',
    emailSource: 'username',
    userIdsIdentifyInstall: true,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'apiKey',
    memberSignIn: 'serverPassword',
    reportsBandwidth: false,
    reportsTranscodeTrackBitrates: false,
    importsTautulliHistory: false,
  },
  emby: {
    sessionIdentity: 'composite',
    terminatesBy: 'sessionKey',
    liveEvents: 'ssePlugin',
    hostStats: 'ssePlugin',
    emailSource: 'username',
    userIdsIdentifyInstall: true,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'apiKey',
    memberSignIn: 'serverPassword',
    reportsBandwidth: false,
    reportsTranscodeTrackBitrates: false,
    importsTautulliHistory: false,
  },
};
