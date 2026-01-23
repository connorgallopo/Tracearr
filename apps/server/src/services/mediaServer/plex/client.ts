/**
 * Plex Media Server Client
 *
 * Implements IMediaServerClient for Plex servers.
 * Provides a unified interface for session tracking, user management, and library access.
 */

import { fetchJson, fetchText, plexHeaders } from '../../../utils/http.js';
import { fileNameFromAnyPath } from '../../../utils/path.js';
import type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  IMediaServerClientWithWatchSync,
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaLibraryItem,
  MediaWatchHistoryItem,
  MediaServerConfig,
} from '../types.js';
import type { WatchedItem } from '@tracearr/shared';
import {
  parseSessionsResponse,
  parseUsersResponse,
  parseLibrariesResponse,
  parseWatchHistoryResponse,
  parseServerResourcesResponse,
  parsePlexTvUser,
  parseXmlUsersResponse,
  parseSharedServersXml,
  parseStatisticsResourcesResponse,
  parseMediaMetadataResponse,
  parseLibraryItemsResponse,
  getTranscodingSessionRatingKeys,
  type PlexServerResource,
  type PlexStatisticsDataPoint,
  type PlexOriginalMedia,
} from './parser.js';

const PLEX_TV_BASE = 'https://plex.tv';

/**
 * Plex Media Server client implementation
 *
 * @example
 * const client = new PlexClient({ url: 'http://plex.local:32400', token: 'xxx' });
 * const sessions = await client.getSessions();
 */
export class PlexClient
  implements IMediaServerClient, IMediaServerClientWithHistory, IMediaServerClientWithWatchSync
{
  public readonly serverType = 'plex' as const;

  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: MediaServerConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.token = config.token;
  }

  /**
   * Build headers for Plex API requests
   */
  private buildHeaders(): Record<string, string> {
    return plexHeaders(this.token);
  }

  /**
   * Build headers for user-specific Plex API requests
   *
   * @param userToken - Optional user-specific token. If provided, uses this token
   *                   instead of the admin token for per-user data access.
   */
  private buildUserHeaders(userToken?: string): Record<string, string> {
    return plexHeaders(userToken ?? this.token);
  }

  // ==========================================================================
  // IMediaServerClient Implementation
  // ==========================================================================

  /**
   * Get all active playback sessions
   *
   * For transcoding sessions, this fetches original media metadata from
   * /library/metadata/{ratingKey} to get accurate source bitrates and details,
   * since Plex's session data shows transcoded output during transcodes.
   */
  async getSessions(): Promise<MediaSession[]> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/status/sessions`, {
      headers: this.buildHeaders(),
      service: 'plex',
      timeout: 10000, // 10s timeout to prevent polling hangs
    });

    // Identify transcoding sessions that need original media metadata
    const transcodingRatingKeys = getTranscodingSessionRatingKeys(data);

    // Fetch original media metadata for transcoding sessions in parallel
    let originalMediaMap: Map<string, PlexOriginalMedia> | undefined;
    if (transcodingRatingKeys.length > 0) {
      const metadataResults = await Promise.allSettled(
        transcodingRatingKeys.map((ratingKey) => this.getMediaMetadata(ratingKey))
      );

      originalMediaMap = new Map();
      metadataResults.forEach((result, index) => {
        const ratingKey = transcodingRatingKeys[index];
        if (result.status === 'fulfilled' && result.value && ratingKey) {
          originalMediaMap!.set(ratingKey, result.value);
        }
        // Silently skip failed fetches - parser will use session data as fallback
      });
    }

    return parseSessionsResponse(data, originalMediaMap);
  }

  /**
   * Get original media metadata for a specific item
   *
   * Used to get true source file information (bitrate, resolution, codec)
   * which is needed because Plex's session data shows transcoded output
   * during transcodes.
   *
   * @param ratingKey - The media item's ratingKey
   * @returns Original media metadata or null if unavailable
   */
  async getMediaMetadata(ratingKey: string): Promise<PlexOriginalMedia | null> {
    try {
      const data = await fetchJson<unknown>(`${this.baseUrl}/library/metadata/${ratingKey}`, {
        headers: this.buildHeaders(),
        service: 'plex',
        timeout: 5000, // Short timeout since this is supplementary data
      });
      return parseMediaMetadataResponse(data);
    } catch {
      // Return null if metadata fetch fails - caller will use fallback
      return null;
    }
  }

  /**
   * Get all local users (accounts from /accounts endpoint)
   *
   * Note: For complete user lists including shared users,
   * use PlexClient.getAllUsersWithLibraries() static method.
   */
  async getUsers(): Promise<MediaUser[]> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/accounts`, {
      headers: this.buildHeaders(),
      service: 'plex',
    });

    return parseUsersResponse(data);
  }

  /**
   * Get all libraries on this server
   */
  async getLibraries(): Promise<MediaLibrary[]> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/library/sections`, {
      headers: this.buildHeaders(),
      service: 'plex',
    });

    return parseLibrariesResponse(data);
  }

  /**
   * Test connection to the server
   */
  async testConnection(): Promise<boolean> {
    try {
      await fetchJson<unknown>(`${this.baseUrl}/`, {
        headers: this.buildHeaders(),
        service: 'plex',
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all items in a library with pagination and external IDs
   *
   * Uses /library/sections/{id}/all endpoint with includeGuids=1 to get
   * external IDs (IMDB, TMDB, TVDB) in the Guid array.
   *
   * @param libraryId - The library section ID
   * @param options - Pagination options (offset, limit)
   * @returns Items and total count for pagination tracking
   */
  async getLibraryItems(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;

    const params = new URLSearchParams({
      includeGuids: '1', // CRITICAL: Required for external IDs
      'X-Plex-Container-Start': String(offset),
      'X-Plex-Container-Size': String(limit),
    });

    const data = await fetchJson<unknown>(
      `${this.baseUrl}/library/sections/${libraryId}/all?${params}`,
      {
        headers: this.buildHeaders(),
        service: 'plex',
        timeout: 30000, // 30s timeout for large responses
      }
    );

    // Extract totalSize from MediaContainer
    const container = data as { MediaContainer?: { totalSize?: number } };
    const totalCount = container?.MediaContainer?.totalSize ?? 0;

    const items = parseLibraryItemsResponse(data);

    return { items, totalCount };
  }

  /**
   * Get all leaf items (episodes) from a library section
   *
   * For TV show libraries, this returns all episodes across all shows.
   * Uses the /library/sections/{id}/allLeaves endpoint.
   *
   * @param libraryId - Library section ID
   * @param options - Pagination options
   * @returns Episodes and total count for pagination tracking
   */
  async getLibraryLeaves(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;

    const params = new URLSearchParams({
      includeGuids: '1',
      'X-Plex-Container-Start': String(offset),
      'X-Plex-Container-Size': String(limit),
    });

    const data = await fetchJson<unknown>(
      `${this.baseUrl}/library/sections/${libraryId}/allLeaves?${params}`,
      {
        headers: this.buildHeaders(),
        service: 'plex',
        timeout: 30000,
      }
    );

    const container = data as { MediaContainer?: { totalSize?: number } };
    const totalCount = container?.MediaContainer?.totalSize ?? 0;

    const items = parseLibraryItemsResponse(data);

    return { items, totalCount };
  }

  // ==========================================================================
  // IMediaServerClientWithHistory Implementation
  // ==========================================================================

  /**
   * Get watch history from server
   */
  async getWatchHistory(options?: {
    userId?: string;
    limit?: number;
  }): Promise<MediaWatchHistoryItem[]> {
    const limit = options?.limit ?? 100;
    const uri = `/status/sessions/history/all?X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`;

    const data = await fetchJson<unknown>(`${this.baseUrl}${uri}`, {
      headers: this.buildHeaders(),
      service: 'plex',
    });

    return parseWatchHistoryResponse(data);
  }

  // ==========================================================================
  // Session Control
  // ==========================================================================

  /**
   * Terminate a playback session
   *
   * Requires Plex Pass subscription on the server.
   *
   * @param sessionId - The Session.id from the sessions API (NOT sessionKey!)
   * @param reason - Optional message displayed to the user in their client
   * @returns true if successful, throws on error
   *
   * @example
   * await client.terminateSession('abc123xyz', 'Concurrent stream limit exceeded');
   */
  async terminateSession(sessionId: string, reason?: string): Promise<boolean> {
    const params = new URLSearchParams({ sessionId });
    if (reason) {
      params.set('reason', reason);
    }

    const response = await fetch(`${this.baseUrl}/status/sessions/terminate?${params}`, {
      method: 'POST',
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Plex Pass subscription required for stream termination');
      }
      if (response.status === 403) {
        throw new Error('Invalid or empty session ID');
      }
      if (response.status === 404) {
        throw new Error('Session not found (may have already ended)');
      }
      throw new Error(`Failed to terminate session: ${response.status} ${response.statusText}`);
    }

    return true;
  }

  // ==========================================================================
  // Server Resource Statistics (Undocumented Endpoint)
  // ==========================================================================

  /**
   * Get server resource statistics (CPU, RAM utilization)
   *
   * Uses the undocumented /statistics/resources endpoint.
   * Returns ~27 data points covering ~2.5 minutes of history at 6-second intervals.
   *
   * @param timespan - Interval between data points in seconds (default: 6)
   * @returns Array of resource data points, sorted newest first
   */
  async getServerStatistics(timespan: number = 6): Promise<PlexStatisticsDataPoint[]> {
    const url = `${this.baseUrl}/statistics/resources?timespan=${timespan}`;

    const data = await fetchJson<unknown>(url, {
      headers: this.buildHeaders(),
      service: 'plex',
      timeout: 10000,
    });

    return parseStatisticsResourcesResponse(data);
  }

  // ==========================================================================
  // IMediaServerClientWithWatchSync Implementation
  // ==========================================================================

  /**
   * Get all watched items for a user (movies and episodes)
   *
   * Fetches watched items from all video libraries with provider IDs for matching.
   *
   * @param userId - Plex user ID (externalId from serverUsers)
   * @param options - Optional filters
   * @param options.userToken - User's server-specific access token (from shared_servers endpoint).
   *                           When provided, this token is used instead of the admin token to get
   *                           that user's personal watch status. Required for shared users.
   */
  async getWatchedItems(
    userId: string,
    options?: {
      includeInProgress?: boolean;
      includeUnwatched?: boolean;
      libraryIds?: string[];
      userToken?: string;
    }
  ): Promise<WatchedItem[]> {
    const PAGE_SIZE = 10000;
    const includeInProgress = options?.includeInProgress ?? true;
    const includeUnwatched = options?.includeUnwatched ?? false;
    const userToken = options?.userToken; // User's personal token for per-user watch status
    const allItems: WatchedItem[] = [];
    const fileNameCache = new Map<string, string[] | undefined>();

    // Get all libraries to fetch watched items from
    const libraries = await this.getLibraries();
    const videoLibraries = libraries.filter(
      (lib) =>
        (lib.type === 'movie' || lib.type === 'show') &&
        (!options?.libraryIds || options.libraryIds.includes(lib.id))
    );

    const fetchLibraryItems = async (
      libraryId: string,
      params: URLSearchParams
    ): Promise<Array<Record<string, unknown>>> => {
      const items: Array<Record<string, unknown>> = [];
      let start = 0;
      let totalSize: number | null = null;

      while (true) {
        const pageParams = new URLSearchParams(params);
        pageParams.set('X-Plex-Container-Start', String(start));
        pageParams.set('X-Plex-Container-Size', String(PAGE_SIZE));

        const data = await fetchJson<{
          MediaContainer?: {
            Metadata?: Array<Record<string, unknown>>;
            size?: number | string;
            totalSize?: number | string;
          };
        }>(`${this.baseUrl}/library/sections/${libraryId}/all?${pageParams.toString()}`, {
          headers: this.buildUserHeaders(userToken),
          service: 'plex',
        });

        const metadata = data?.MediaContainer?.Metadata ?? [];
        items.push(...metadata);

        const totalRaw = data?.MediaContainer?.totalSize;
        if (totalRaw !== undefined && totalRaw !== null) {
          const parsed = typeof totalRaw === 'number' ? totalRaw : parseInt(totalRaw, 10);
          if (!Number.isNaN(parsed)) {
            totalSize = parsed;
          }
        }

        if (metadata.length === 0) {
          break;
        }

        if (totalSize !== null && start + metadata.length >= totalSize) {
          break;
        }

        if (metadata.length < PAGE_SIZE) {
          break;
        }

        start += metadata.length;
      }

      return items;
    };

    for (const library of videoLibraries) {
      // Fetch items from this library
      // For Plex, we use the /all endpoint with type filters
      const isMovieLibrary = library.type === 'movie';
      const typeParam = isMovieLibrary ? '1' : '4'; // 1=movie, 4=episode

      try {
        // If includeUnwatched, fetch ALL items with pagination
        if (includeUnwatched) {
          const params = new URLSearchParams({
            type: typeParam,
            includeGuids: '1',
          });
          const allMetadata = await fetchLibraryItems(library.id, params);
          for (const item of allMetadata) {
            const watchedItem = this.parseWatchedItemWithState(
              item,
              isMovieLibrary ? 'movie' : 'episode'
            );
            if (watchedItem) {
              if (!watchedItem.fileNames?.length) {
                watchedItem.fileNames = await this.getItemFileNames(
                  watchedItem.serverItemId,
                  userToken,
                  fileNameCache
                );
              }
              watchedItem.libraryName = library.name;
              allItems.push(watchedItem);
            }
          }
          continue; // Move to next library
        }

        // Original behavior: fetch watched and in-progress separately
        // Fetch watched (completed) items
        const watchedParams = new URLSearchParams({
          type: typeParam,
          unwatched: '0',
          includeGuids: '1',
        });
        const watchedMetadata = await fetchLibraryItems(library.id, watchedParams);
        for (const item of watchedMetadata) {
          const watchedItem = this.parseWatchedItem(item, isMovieLibrary ? 'movie' : 'episode');
          if (watchedItem) {
            if (!watchedItem.fileNames?.length) {
              watchedItem.fileNames = await this.getItemFileNames(
                watchedItem.serverItemId,
                userToken,
                fileNameCache
              );
            }
            watchedItem.libraryName = library.name;
            allItems.push(watchedItem);
          }
        }

        // Fetch in-progress items if requested
        if (includeInProgress) {
          const inProgressParams = new URLSearchParams({
            type: typeParam,
            unwatched: '1',
            includeGuids: '1',
          });
          inProgressParams.set('viewOffset>', '60000');
          const inProgressMetadata = await fetchLibraryItems(library.id, inProgressParams);
          for (const item of inProgressMetadata) {
            const watchedItem = this.parseWatchedItem(
              item,
              isMovieLibrary ? 'movie' : 'episode',
              false
            );
            if (watchedItem) {
              if (!watchedItem.fileNames?.length) {
                watchedItem.fileNames = await this.getItemFileNames(
                  watchedItem.serverItemId,
                  userToken,
                  fileNameCache
                );
              }
              watchedItem.libraryName = library.name;
              allItems.push(watchedItem);
            }
          }
        }
      } catch (error) {
        // Skip libraries that fail (user may not have access)
        console.error(`Failed to fetch watched items from library ${library.name}:`, error);
      }
    }

    return allItems;
  }

  /**
   * Parse a Plex item with watch state from viewCount/viewOffset
   */
  private parseWatchedItemWithState(
    item: Record<string, unknown>,
    type: 'movie' | 'episode'
  ): WatchedItem | null {
    // Determine completed state from viewCount
    const viewCount = (item.viewCount as number) ?? 0;
    const completed = viewCount > 0;
    return this.parseWatchedItem(item, type, completed);
  }

  /**
   * Parse a Plex item into a WatchedItem
   */
  private parseWatchedItem(
    item: Record<string, unknown>,
    type: 'movie' | 'episode',
    completed: boolean = true
  ): WatchedItem | null {
    const ratingKey = item.ratingKey as string;
    if (!ratingKey) return null;

    // Extract provider IDs from Guid array
    const guids = (item.Guid ?? item.guids) as Array<{ id?: string }> | undefined;
    let imdbId: string | undefined;
    let tmdbId: number | undefined;
    let tvdbId: number | undefined;

    if (Array.isArray(guids)) {
      for (const guid of guids) {
        const id = guid.id ?? '';
        if (id.startsWith('imdb://')) {
          imdbId = id.replace('imdb://', '');
        } else if (id.startsWith('tmdb://')) {
          tmdbId = parseInt(id.replace('tmdb://', ''), 10);
        } else if (id.startsWith('tvdb://')) {
          tvdbId = parseInt(id.replace('tvdb://', ''), 10);
        }
      }
    }

    // Basic item info
    const title = (item.title as string) ?? '';
    const year = (item.year as number) ?? undefined;
    const durationMs = (item.duration as number) ?? 0;
    const viewOffset = (item.viewOffset as number) ?? 0;
    const lastViewedAt = item.lastViewedAt as number | undefined;

    const watchedItem: WatchedItem = {
      title,
      type,
      year,
      imdbId,
      tmdbId,
      tvdbId,
      fileNames: this.collectFileNames(item),
      completed,
      progressMs: completed ? durationMs : viewOffset,
      totalDurationMs: durationMs,
      viewedAt: lastViewedAt ? new Date(lastViewedAt * 1000) : undefined,
      serverItemId: ratingKey,
    };

    // Add episode-specific info
    if (type === 'episode') {
      watchedItem.showTitle = (item.grandparentTitle as string) ?? undefined;
      watchedItem.seasonNumber = (item.parentIndex as number) ?? undefined;
      watchedItem.episodeNumber = (item.index as number) ?? undefined;

      // Try to get show provider IDs from grandparent
      const showGuids = (item.grandparentGuid ?? []) as Array<{ id?: string }>;
      if (Array.isArray(showGuids)) {
        for (const guid of showGuids) {
          const id = guid.id ?? '';
          if (id.startsWith('imdb://')) {
            watchedItem.showImdbId = id.replace('imdb://', '');
          } else if (id.startsWith('tmdb://')) {
            watchedItem.showTmdbId = parseInt(id.replace('tmdb://', ''), 10);
          } else if (id.startsWith('tvdb://')) {
            watchedItem.showTvdbId = parseInt(id.replace('tvdb://', ''), 10);
          }
        }
      }
    }

    return watchedItem;
  }

  /**
   * Collect file names from Plex media parts (basenames only)
   */
  private collectFileNames(item: Record<string, unknown>): string[] | undefined {
    const fileNames = new Set<string>();
    const media = item.Media as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(media)) return undefined;

    for (const mediaItem of media) {
      const parts = mediaItem.Part as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const filePath = part.file as string | undefined;
        if (!filePath) continue;
        const fileName = fileNameFromAnyPath(filePath);
        if (fileName) fileNames.add(fileName);
      }
    }

    return fileNames.size > 0 ? [...fileNames] : undefined;
  }

  /**
   * Fetch file names for a Plex item via metadata endpoint (fallback when list views omit parts)
   *
   * @param ratingKey - The Plex ratingKey of the item
   * @param userToken - Optional user-specific token for per-user access
   * @param cache - Cache map to avoid redundant API calls
   */
  private async getItemFileNames(
    ratingKey: string,
    userToken: string | undefined,
    cache: Map<string, string[] | undefined>
  ): Promise<string[] | undefined> {
    if (!ratingKey) return undefined;
    if (cache.has(ratingKey)) return cache.get(ratingKey);

    try {
      const data = await fetchJson<{
        MediaContainer?: { Metadata?: Array<Record<string, unknown>> };
      }>(`${this.baseUrl}/library/metadata/${ratingKey}`, {
        headers: this.buildUserHeaders(userToken),
        service: 'plex',
      });

      const metadata = data?.MediaContainer?.Metadata ?? [];
      const item = metadata[0] as Record<string, unknown> | undefined;
      const fileNames = item ? this.collectFileNames(item) : undefined;
      cache.set(ratingKey, fileNames);
      return fileNames;
    } catch (error) {
      console.error(`Failed to fetch Plex metadata for item ${ratingKey}:`, error);
      cache.set(ratingKey, undefined);
      return undefined;
    }
  }

  /**
   * Mark an item as watched (completed)
   *
   * Uses the Plex scrobble endpoint to mark an item as fully watched.
   *
   * @param userId - Plex user ID (kept for interface consistency)
   * @param itemId - The ratingKey of the item to mark as watched
   * @param viewedAt - Optional timestamp (Plex doesn't support custom timestamps)
   * @param userToken - Optional user-specific token for per-user scrobble
   */
  async markWatched(
    userId: string,
    itemId: string,
    viewedAt?: Date,
    userToken?: string
  ): Promise<boolean> {
    // Plex uses the scrobble endpoint to mark items as watched
    // Note: viewedAt is ignored as Plex doesn't support custom watched timestamps
    const response = await fetch(
      `${this.baseUrl}/:/scrobble?key=${itemId}&identifier=com.plexapp.plugins.library`,
      {
        method: 'GET', // Plex uses GET for scrobble
        headers: this.buildUserHeaders(userToken),
      }
    );

    return response.ok;
  }

  /**
   * Update playback progress for partial watches
   *
   * Uses the Plex timeline/progress endpoint to update the view offset.
   *
   * @param userId - Plex user ID (kept for interface consistency)
   * @param itemId - The ratingKey of the item
   * @param progressMs - Current playback position in milliseconds
   * @param userToken - Optional user-specific token for per-user progress update
   */
  async updateProgress(
    userId: string,
    itemId: string,
    progressMs: number,
    userToken?: string
  ): Promise<boolean> {
    const response = await fetch(
      `${this.baseUrl}/:/progress?key=${itemId}&time=${progressMs}&identifier=com.plexapp.plugins.library&state=stopped`,
      {
        method: 'GET', // Plex uses GET for progress updates
        headers: this.buildUserHeaders(userToken),
      }
    );

    return response.ok;
  }

  // ==========================================================================
  // Static Methods - Plex.tv API Operations
  // ==========================================================================

  /**
   * Initiate OAuth flow for Plex authentication
   * Returns a PIN ID and auth URL for user to authorize
   * @param forwardUrl - URL to redirect to after auth (for popup auto-close)
   */
  static async initiateOAuth(forwardUrl?: string): Promise<{ pinId: string; authUrl: string }> {
    const headers = plexHeaders();

    const data = await fetchJson<{ id: number; code: string }>(`${PLEX_TV_BASE}/api/v2/pins`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ strong: 'true' }),
      service: 'plex.tv',
    });

    const params = new URLSearchParams({
      clientID: 'tracearr',
      code: data.code,
      'context[device][product]': 'Tracearr',
    });

    if (forwardUrl) {
      params.set('forwardUrl', forwardUrl);
    }

    const authUrl = `https://app.plex.tv/auth#?${params.toString()}`;

    return {
      pinId: String(data.id),
      authUrl,
    };
  }

  /**
   * Check if OAuth PIN has been authorized
   * Returns auth result if authorized, null if still pending
   */
  static async checkOAuthPin(pinId: string): Promise<{
    id: string;
    username: string;
    email: string;
    thumb: string;
    token: string;
  } | null> {
    const headers = plexHeaders();

    const pin = await fetchJson<{ authToken: string | null }>(
      `${PLEX_TV_BASE}/api/v2/pins/${pinId}`,
      { headers, service: 'plex.tv' }
    );

    if (!pin.authToken) {
      return null;
    }

    // Fetch user info with the token
    const user = await fetchJson<Record<string, unknown>>(`${PLEX_TV_BASE}/api/v2/user`, {
      headers: plexHeaders(pin.authToken),
      service: 'plex.tv',
    });

    return {
      id: String(user.id ?? ''),
      username: String(user.username ?? ''),
      email: String(user.email ?? ''),
      thumb: String(user.thumb ?? ''),
      token: pin.authToken,
    };
  }

  /**
   * Error types for server admin verification
   */
  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  /**
   * Verify if token has admin access to a Plex server.
   *
   * @throws Error with code 'CONNECTION_FAILED' if server is unreachable
   * @throws Error with code 'NOT_ADMIN' if user doesn't have admin access
   */
  static async verifyServerAdmin(
    token: string,
    serverUrl: string
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    const url = serverUrl.replace(/\/$/, '');
    const headers = plexHeaders(token);

    // First verify basic server connectivity
    try {
      await fetchJson<unknown>(`${url}/`, {
        headers,
        service: 'plex',
        timeout: 10000,
      });
    } catch (error) {
      // Connection failed - server unreachable, timeout, SSL error, etc.
      const message = error instanceof Error ? error.message : 'Unable to connect to server';

      return {
        success: false,
        code: PlexClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot reach Plex server at ${url}. ${message}`,
      };
    }

    // Then verify admin access by fetching accounts (admin-only endpoint)
    try {
      await fetchJson<unknown>(`${url}/accounts`, {
        headers,
        service: 'plex',
        timeout: 10000,
      });
    } catch {
      // Server is reachable but user doesn't have admin access
      return {
        success: false,
        code: PlexClient.AdminVerifyError.NOT_ADMIN,
        message: 'You must be an admin on this Plex server',
      };
    }

    return { success: true };
  }

  /**
   * Get user's owned Plex servers from plex.tv
   */
  static async getServers(token: string): Promise<PlexServerResource[]> {
    const data = await fetchJson<unknown>(
      `${PLEX_TV_BASE}/api/v2/resources?includeHttps=1&includeRelay=0`,
      {
        headers: plexHeaders(token),
        service: 'plex.tv',
      }
    );

    return parseServerResourcesResponse(data, token);
  }

  /**
   * Get owner account info from plex.tv
   */
  static async getAccountInfo(token: string): Promise<MediaUser> {
    const user = await fetchJson<Record<string, unknown>>(`${PLEX_TV_BASE}/api/v2/user`, {
      headers: plexHeaders(token),
      service: 'plex.tv',
    });

    return parsePlexTvUser(
      {
        ...user,
        isAdmin: true,
      },
      [] // Owner has access to all libraries
    );
  }

  /**
   * Get all shared users from plex.tv (XML endpoint)
   */
  static async getFriends(token: string): Promise<MediaUser[]> {
    const headers = {
      ...plexHeaders(token),
      Accept: 'application/xml',
    };

    const xml = await fetchText(`${PLEX_TV_BASE}/api/users`, {
      headers,
      service: 'plex.tv',
    });

    return parseXmlUsersResponse(xml);
  }

  /**
   * Get shared server info (server_token and shared_libraries per user)
   */
  static async getSharedServerUsers(
    token: string,
    machineIdentifier: string
  ): Promise<Map<string, { serverToken: string; sharedLibraries: string[] }>> {
    const headers = {
      ...plexHeaders(token),
      Accept: 'application/xml',
    };

    try {
      const xml = await fetchText(
        `${PLEX_TV_BASE}/api/servers/${machineIdentifier}/shared_servers`,
        { headers, service: 'plex.tv' }
      );

      return parseSharedServersXml(xml);
    } catch {
      // Return empty map if endpoint fails
      return new Map();
    }
  }

  /**
   * Get all users with access to a specific server
   * Combines /api/users + /api/servers/{id}/shared_servers
   */
  static async getAllUsersWithLibraries(
    token: string,
    machineIdentifier: string
  ): Promise<MediaUser[]> {
    const [owner, allFriends, sharedServerMap] = await Promise.all([
      PlexClient.getAccountInfo(token),
      PlexClient.getFriends(token),
      PlexClient.getSharedServerUsers(token, machineIdentifier),
    ]);

    // Enrich friends with shared_libraries and serverToken from shared_servers
    // Only include users who have access to THIS server
    console.log(
      `[PlexClient] getAllUsersWithLibraries: sharedServerMap has ${sharedServerMap.size} entries`
    );
    const usersWithAccess = allFriends
      .filter((friend) => sharedServerMap.has(friend.id))
      .map((friend) => {
        const sharedInfo = sharedServerMap.get(friend.id);
        console.log(
          `[PlexClient] User ${friend.username} (id=${friend.id}): ` +
            `serverToken=${sharedInfo?.serverToken ? 'present' : 'missing'}`
        );
        return {
          ...friend,
          sharedLibraries: sharedInfo?.sharedLibraries ?? [],
          serverToken: sharedInfo?.serverToken,
        };
      });

    // Owner always has access to all libraries (uses admin token, no separate serverToken)
    return [owner, ...usersWithAccess];
  }
}
