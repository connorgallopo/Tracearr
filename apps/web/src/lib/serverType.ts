import { assertNever, type JellyfinEmbyServerType, type ServerType } from '@tracearr/shared';

export function isJellyfinEmby(type: ServerType): type is JellyfinEmbyServerType {
  switch (type) {
    case 'plex':
      return false;
    case 'jellyfin':
      return true;
    case 'emby':
      return true;
    case 'tofa':
      return false;
    default:
      return assertNever(type);
  }
}

/** Servers Tracearr reaches with a URL and an API key, whichever way the key was made. */
export type ApiKeyServerType = Extract<ServerType, 'jellyfin' | 'emby' | 'tofa'>;

export function holdsApiKey(type: ServerType): type is ApiKeyServerType {
  switch (type) {
    case 'plex':
      return false;
    case 'jellyfin':
    case 'emby':
    case 'tofa':
      return true;
    default:
      return assertNever(type);
  }
}

/** The add-server form asks for the URL and API key first; tofa signs in and makes its own key. */
export function addsByApiKey(type: ServerType): boolean {
  switch (type) {
    case 'plex':
      return false;
    case 'jellyfin':
    case 'emby':
      return true;
    case 'tofa':
      return false;
    default:
      return assertNever(type);
  }
}
