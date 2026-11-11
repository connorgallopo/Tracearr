/**
 * Media Server Client Module
 *
 * Provides a unified interface for Plex and Jellyfin media server integrations.
 * Use the factory function to create clients based on server type.
 *
 * @example
 * import { createMediaServerClient, type IMediaServerClient } from './services/mediaServer';
 *
 * const client = createMediaServerClient({
 *   type: 'plex',
 *   url: 'http://plex.local:32400',
 *   token: 'encrypted-token',
 * });
 *
 * const sessions = await client.getSessions();
 * const users = await client.getUsers();
 */

import { assertNever, type JellyfinEmbyServerType, type ServerType } from '@tracearr/shared';
import { PlexClient } from './plex/client.js';
import { JellyfinClient } from './jellyfin/client.js';
import { EmbyClient } from './emby/client.js';
import type { IMediaServerClient, MediaServerConfig, CreateClientOptions } from './types.js';

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a media server client for the specified server type
 *
 * @param options - Client configuration including server type, URL, and token
 * @returns A media server client implementing IMediaServerClient
 * @throws Error if unknown server type is provided
 *
 * @example
 * const client = createMediaServerClient({
 *   type: server.type,
 *   url: server.url,
 *   token: server.token,
 * });
 *
 * // Use polymorphically
 * const sessions = await client.getSessions();
 */
export function createMediaServerClient(options: CreateClientOptions): IMediaServerClient {
  const config: MediaServerConfig = {
    url: options.url,
    token: options.token,
    id: options.id,
    name: options.name,
  };

  switch (options.type) {
    case 'plex':
      return new PlexClient(config);
    case 'jellyfin':
      return new JellyfinClient(config);
    case 'emby':
      return new EmbyClient(config);
    default:
      return assertNever(options.type);
  }
}

export function createJellyfinEmbyClient(
  type: JellyfinEmbyServerType,
  config: MediaServerConfig
): JellyfinClient | EmbyClient {
  switch (type) {
    case 'jellyfin':
      return new JellyfinClient(config);
    case 'emby':
      return new EmbyClient(config);
    default:
      return assertNever(type);
  }
}

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

export function verifyServerAdmin(type: ServerType, token: string, url: string) {
  switch (type) {
    case 'plex':
      return PlexClient.verifyServerAdmin(token, url);
    case 'jellyfin':
      return JellyfinClient.verifyServerAdmin(token, url);
    case 'emby':
      return EmbyClient.verifyServerAdmin(token, url);
    default:
      return assertNever(type);
  }
}

export function logoutUserToken(
  type: JellyfinEmbyServerType,
  serverUrl: string,
  token: string
): Promise<void> {
  switch (type) {
    case 'jellyfin':
      return JellyfinClient.logoutUserToken(serverUrl, token);
    case 'emby':
      return EmbyClient.logoutUserToken(serverUrl, token);
    default:
      return assertNever(type);
  }
}

// ============================================================================
// Re-exports
// ============================================================================

// Types
export type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  MediaServerConfig,
  CreateClientOptions,
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaLibraryItem,
  MediaWatchHistoryItem,
} from './types.js';

// Clients (for static method access and direct instantiation)
export { PlexClient } from './plex/client.js';
export { JellyfinClient } from './jellyfin/client.js';
export { EmbyClient } from './emby/client.js';

// Plex-specific types
export type { PlexServerResource, PlexServerConnection } from './plex/parser.js';

// Jellyfin-specific types
export type { JellyfinActivityEntry } from './jellyfin/parser.js';

// Emby-specific types
export type { EmbyActivityEntry } from './emby/parser.js';

// Parsers (for testing and direct use)
export * as plexParser from './plex/parser.js';
export * as jellyfinParser from './jellyfin/parser.js';
export * as embyParser from './emby/parser.js';
