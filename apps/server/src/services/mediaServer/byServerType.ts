import { SERVER_PROFILES, assertNever, usernameAsEmail, type ServerType } from '@tracearr/shared';
import { getWatchedThreshold } from '../settings.js';
import { TOFA_STOP_REFUSED, TofaClient } from './tofa/client.js';
import { LIVE_VIEWER_PREFIX } from './tofa/parser.js';

/** The email for an account first seen in a session, which carries none: user sync fills it where the server reports one. */
export function emailForSessionUser(type: ServerType, username: string): string | null {
  const source = SERVER_PROFILES[type].emailSource;
  switch (source) {
    case 'server':
      return null;
    case 'username':
      return usernameAsEmail(username);
    default:
      return assertNever(source);
  }
}

/**
 * What the server row keeps about the server's own settings, read whenever its address or key
 * is set. Only tofa reports any: whether the API key may stop streams, and its watched rule.
 */
export async function readServerFacts(
  type: ServerType,
  url: string,
  token: string
): Promise<{ canStopStreams?: boolean; watchedRulePercent?: number | null }> {
  switch (type) {
    case 'plex':
    case 'jellyfin':
    case 'emby':
    case 'silo':
      return {};
    case 'tofa': {
      const client = new TofaClient({ url, token });
      const [scopes, watchedRulePercent] = await Promise.all([
        client.getKeyScopes(),
        client.getWatchedRulePercent(),
      ]);
      return { canStopStreams: scopes.canStopStreams, watchedRulePercent };
    }
    default:
      return assertNever(type);
  }
}

/**
 * The completion fraction at which a play counts as watched: Tracearr's setting, or the
 * server's own rule where the server has one and reported it.
 */
export async function serverWatchedThreshold(
  server: { type: ServerType; watchedRulePercent: number | null },
  mediaType: string
): Promise<number> {
  const source = SERVER_PROFILES[server.type].watchedThreshold;
  switch (source) {
    case 'tracearrSetting':
      return getWatchedThreshold(mediaType);
    case 'serverRule':
      return server.watchedRulePercent === null
        ? getWatchedThreshold(mediaType)
        : server.watchedRulePercent / 100;
    default:
      return assertNever(source);
  }
}

/** Why Tracearr must not ask the server to stop this session, or null when it may ask. */
export function stopRefusal(session: {
  sessionKey: string;
  server: { type: ServerType; canStopStreams: boolean | null };
}): string | null {
  const { server } = session;
  switch (server.type) {
    case 'plex':
    case 'jellyfin':
    case 'emby':
    case 'silo':
      return null;
    case 'tofa':
      if (session.sessionKey.startsWith(LIVE_VIEWER_PREFIX)) {
        return 'tofa has no way for Tracearr to stop a live TV viewer without a playback session';
      }
      return server.canStopStreams === false ? TOFA_STOP_REFUSED : null;
    default:
      return assertNever(server.type);
  }
}
