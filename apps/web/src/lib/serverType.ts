import {
  SERVER_PROFILES,
  assertNever,
  type JellyfinEmbyServerType,
  type ServerType,
} from '@tracearr/shared';

export function isJellyfinEmby(type: ServerType): type is JellyfinEmbyServerType {
  switch (type) {
    case 'plex':
      return false;
    case 'jellyfin':
    case 'emby':
      return true;
    case 'tofa':
    case 'silo':
      return false;
    default:
      return assertNever(type);
  }
}

/** Servers Tracearr reaches with a URL and an API key, whichever way the key was made. */
export type ApiKeyServerType = Extract<ServerType, 'jellyfin' | 'emby' | 'tofa' | 'silo'>;

export function holdsApiKey(type: ServerType): type is ApiKeyServerType {
  switch (type) {
    case 'plex':
      return false;
    case 'jellyfin':
    case 'emby':
    case 'tofa':
    case 'silo':
      return true;
    default:
      return assertNever(type);
  }
}

/** The add-server form asks for the URL and API key first; tofa signs in and Silo approves a code, and each makes its own key. */
export function addsByApiKey(type: ServerType): boolean {
  switch (type) {
    case 'plex':
      return false;
    case 'jellyfin':
    case 'emby':
      return true;
    case 'tofa':
    case 'silo':
      return false;
    default:
      return assertNever(type);
  }
}

/** Servers whose members sign in through the member form, with their own account on the server. */
export type ServerAccountSignInType = Extract<ServerType, 'jellyfin' | 'emby' | 'silo'>;

/** By password or by a code approved on the server; Plex and tofa members use their own buttons. */
export function signsInThroughServerAccount(type: ServerType): type is ServerAccountSignInType {
  const { memberSignIn } = SERVER_PROFILES[type];
  switch (memberSignIn) {
    case 'serverPassword':
    case 'siloPairing':
      return true;
    case 'plexTv':
    case 'tofaCloud':
    case 'unavailable':
      return false;
    default:
      return assertNever(memberSignIn);
  }
}
