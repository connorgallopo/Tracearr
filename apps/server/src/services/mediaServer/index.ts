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

import { PlexClient } from './plex/client.js';
import { JellyfinClient } from './jellyfin/client.js';
import { EmbyClient } from './emby/client.js';
import type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  MediaServerConfig,
  CreateClientOptions,
} from './types.js';

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
      throw new Error(`Unknown media server type: ${options.type as string}`);
  }
}

/**
 * Type guard to check if a client supports watch history
 */
export function supportsWatchHistory(
  client: IMediaServerClient
): client is IMediaServerClientWithHistory {
  return (
    'getWatchHistory' in client &&
    typeof (client as IMediaServerClientWithHistory).getWatchHistory === 'function'
  );
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
  MediaWatchHistoryItem,
} from './types.js';

// Clients (for static method access and direct instantiation)
export { PlexClient } from './plex/client.js';
export { JellyfinClient } from './jellyfin/client.js';
export { EmbyClient } from './emby/client.js';

// Plex-specific types
export type { PlexServerResource, PlexServerConnection } from './plex/parser.js';

// Jellyfin-specific types
export type { JellyfinActivityEntry, JellyfinAuthResult } from './jellyfin/parser.js';

// Emby-specific types
export type { EmbyActivityEntry, EmbyAuthResult } from './emby/parser.js';

// Parsers (for testing and direct use)
export * as plexParser from './plex/parser.js';
export * as jellyfinParser from './jellyfin/parser.js';
export * as embyParser from './emby/parser.js';
