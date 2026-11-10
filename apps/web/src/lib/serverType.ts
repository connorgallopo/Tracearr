import { assertNever, type JellyfinEmbyServerType, type ServerType } from '@tracearr/shared';

export function isJellyfinEmby(type: ServerType): type is JellyfinEmbyServerType {
  switch (type) {
    case 'plex':
      return false;
    case 'jellyfin':
      return true;
    case 'emby':
      return true;
    default:
      return assertNever(type);
  }
}
