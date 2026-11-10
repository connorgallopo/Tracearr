export const SERVER_TYPES = ['plex', 'jellyfin', 'emby'] as const;

export type ServerType = (typeof SERVER_TYPES)[number];

export type JellyfinEmbyServerType = Extract<ServerType, 'jellyfin' | 'emby'>;

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
