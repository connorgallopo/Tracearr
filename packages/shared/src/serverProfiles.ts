import { SERVER_STATS_CONFIG } from './constants.js';
import { assertNever, type ServerType } from './serverTypes.js';

export interface ServerProfile {
  /** The product's name, written the way the product writes it. */
  displayName: string;
  /** composite: keyed by user, device and item, because the server's session id changes when a client restarts playback. */
  sessionIdentity: 'sessionKey' | 'composite';
  /** The id the server needs to stop a playback. */
  terminatesBy: 'plexSessionId' | 'sessionKey';
  /** ssePlugin: needs the Tracearr SSE plugin installed on the server; without it the poller covers the server. */
  liveEvents: 'plexWebsocket' | 'ssePlugin' | 'tofaSocket';
  /** Where host CPU and memory come from: Plex's statistics endpoint, the SSE plugin's stats events, or tofa's metrics endpoint. */
  hostStats: 'plexStatistics' | 'ssePlugin' | 'tofaMetrics';
  /** Seconds between host samples while nothing is reading them; null when the server samples at one rate. */
  hostStatsIdleSeconds: number | null;
  /** username: the server reports no email, so an account's email is its username when that is an address. */
  emailSource: 'server' | 'username';
  /** User ids are minted per install, so one shared id proves two addresses reach the same install. */
  userIdsIdentifyInstall: boolean;
  /** The player name is the device name the server reports, not a title the user chose, so it can classify the device. */
  playerNameCountsTowardDevice: boolean;
  /** History imported for this server is linked to library items after a library sync. */
  linksImportedHistory: boolean;
  /** How the owner adds the server: picked from a linked Plex account, by URL and API key, or picked from the owner's tofa account, which makes the key. */
  addServerAuth: 'plexOAuth' | 'apiKey' | 'tofaCloud';
  /** How members sign in: through plex.tv, with their username and password on the server, through their tofa account, or not at all when the server offers no sign-in Tracearr can call. */
  memberSignIn: 'plexTv' | 'serverPassword' | 'tofaCloud' | 'unavailable';
  /** The server measures its own bandwidth, so the dashboard can chart it. */
  reportsBandwidth: boolean;
  /** A transcode reports separate video and audio bitrates; without them only the total stream bitrate is known. */
  reportsTranscodeTrackBitrates: boolean;
  /** Tautulli tracks this server, so its play history can be imported from Tautulli. */
  importsTautulliHistory: boolean;
  /** The importer for the watch history the server keeps itself; null when it keeps none. */
  serverHistoryImport: 'tofa' | null;
  /** Which rule counts a play as watched: Tracearr's own setting, or the completion percent the server reports. */
  watchedThreshold: 'tracearrSetting' | 'serverRule';
  /** The request service the server's own requests are mirrored through, created and removed with the server; null when it has none. */
  builtInRequests: 'tofa' | null;
  /** Hosts outside the server that its program guide links live TV art from. */
  guideImageHosts: readonly string[];
  /** Where a link to one item opens: the vendor's hosted web app, or the server's own address, which members must be able to reach. */
  itemLinks: 'hostedApp' | 'serverAddress';
}

export const SERVER_PROFILES: Record<ServerType, ServerProfile> = {
  plex: {
    displayName: 'Plex',
    sessionIdentity: 'sessionKey',
    terminatesBy: 'plexSessionId',
    liveEvents: 'plexWebsocket',
    hostStats: 'plexStatistics',
    hostStatsIdleSeconds: null,
    emailSource: 'server',
    userIdsIdentifyInstall: false,
    playerNameCountsTowardDevice: false,
    linksImportedHistory: true,
    addServerAuth: 'plexOAuth',
    memberSignIn: 'plexTv',
    reportsBandwidth: true,
    reportsTranscodeTrackBitrates: true,
    importsTautulliHistory: true,
    serverHistoryImport: null,
    watchedThreshold: 'tracearrSetting',
    builtInRequests: null,
    guideImageHosts: ['plex.tmsimg.com'],
    itemLinks: 'hostedApp',
  },
  jellyfin: {
    displayName: 'Jellyfin',
    sessionIdentity: 'composite',
    terminatesBy: 'sessionKey',
    liveEvents: 'ssePlugin',
    hostStats: 'ssePlugin',
    hostStatsIdleSeconds: null,
    emailSource: 'username',
    userIdsIdentifyInstall: true,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'apiKey',
    memberSignIn: 'serverPassword',
    reportsBandwidth: false,
    reportsTranscodeTrackBitrates: false,
    importsTautulliHistory: false,
    serverHistoryImport: null,
    watchedThreshold: 'tracearrSetting',
    builtInRequests: null,
    guideImageHosts: [],
    itemLinks: 'serverAddress',
  },
  emby: {
    displayName: 'Emby',
    sessionIdentity: 'composite',
    terminatesBy: 'sessionKey',
    liveEvents: 'ssePlugin',
    hostStats: 'ssePlugin',
    hostStatsIdleSeconds: null,
    emailSource: 'username',
    userIdsIdentifyInstall: true,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'apiKey',
    memberSignIn: 'serverPassword',
    reportsBandwidth: false,
    reportsTranscodeTrackBitrates: false,
    importsTautulliHistory: false,
    serverHistoryImport: null,
    watchedThreshold: 'tracearrSetting',
    builtInRequests: null,
    guideImageHosts: [],
    itemLinks: 'serverAddress',
  },
  tofa: {
    displayName: 'tofa',
    sessionIdentity: 'sessionKey',
    terminatesBy: 'sessionKey',
    liveEvents: 'tofaSocket',
    hostStats: 'tofaMetrics',
    hostStatsIdleSeconds: 30,
    emailSource: 'server',
    userIdsIdentifyInstall: false,
    playerNameCountsTowardDevice: true,
    linksImportedHistory: false,
    addServerAuth: 'tofaCloud',
    memberSignIn: 'tofaCloud',
    reportsBandwidth: false,
    reportsTranscodeTrackBitrates: false,
    importsTautulliHistory: false,
    serverHistoryImport: 'tofa',
    watchedThreshold: 'serverRule',
    builtInRequests: 'tofa',
    guideImageHosts: ['api.tofa.tv'],
    itemLinks: 'hostedApp',
  },
};

/**
 * How long a server's live stats line may go without a sample before it breaks. A server that
 * slows down while nothing reads it is bridged across that slower interval, with room for a late
 * sample.
 */
export function liveStatsGapSeconds(serverType: ServerType): number {
  const idle = SERVER_PROFILES[serverType].hostStatsIdleSeconds;
  return Math.max(SERVER_STATS_CONFIG.GAP_BREAK_SECONDS, idle === null ? 0 : idle + 5);
}

/**
 * How the owner proves an account on the server is theirs before it joins them: Plex links the
 * plex.tv account itself, Jellyfin and Emby take the account's username typed back, and tofa needs
 * a tofa sign-in as that account, since it also becomes the owner's tofa login.
 */
export type OwnerLinkProof = 'plexAccount' | 'typedUsername' | 'tofaSignIn';

export function ownerLinkProof(type: ServerType): OwnerLinkProof {
  switch (type) {
    case 'plex':
      return 'plexAccount';
    case 'jellyfin':
    case 'emby':
      return 'typedUsername';
    case 'tofa':
      return 'tofaSignIn';
    default:
      return assertNever(type);
  }
}
