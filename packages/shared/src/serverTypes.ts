export const SERVER_TYPES = ['plex', 'jellyfin', 'emby'] as const;

export type ServerType = (typeof SERVER_TYPES)[number];

export function isServerType(value: string): value is ServerType {
  return (SERVER_TYPES as readonly string[]).includes(value);
}

export type JellyfinEmbyServerType = Extract<ServerType, 'jellyfin' | 'emby'>;

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
