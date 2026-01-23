/**
 * Base Media Server Client for Jellyfin/Emby
 *
 * Provides shared functionality for both platforms, which have nearly identical APIs.
 * Platform-specific differences (stream decisions, lastPausedDate, activity log params)
 * are handled by abstract methods or configuration.
 */

import { fetchJson, jellyfinEmbyHeaders } from '../../../utils/http.js';
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

// Client identification constants
const CLIENT_NAME = 'Tracearr';
const CLIENT_VERSION = '1.0.0';
const DEVICE_ID = 'tracearr-server';
const DEVICE_NAME = 'Tracearr Server';

/**
 * Activity log entry type - identical structure for Jellyfin and Emby
 */
export interface JellyfinEmbyActivityEntry {
  id: number;
  name: string;
  overview?: string;
  shortOverview?: string;
  type: string;
  itemId?: string;
  userId?: string;
  date: string;
  severity: string;
}

/**
 * Authentication result type - identical structure for Jellyfin and Emby
 */
export interface JellyfinEmbyAuthResult {
  id: string;
  username: string;
  token: string;
  serverId: string;
  isAdmin: boolean;
}

/**
 * Item result type for batch fetching - identical structure for Jellyfin and Emby
 */
export interface JellyfinEmbyItemResult {
  Id: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  ImageTags?: {
    Primary?: string;
  };
  SeriesId?: string;
  SeriesPrimaryImageTag?: string;
}

/**
 * Parser functions required by the base client
 */
export interface MediaServerParsers {
  parseSessionsResponse: (data: unknown[]) => MediaSession[];
  parseUsersResponse: (data: unknown[]) => MediaUser[];
  parseLibrariesResponse: (data: unknown[]) => MediaLibrary[];
  parseWatchHistoryResponse: (data: unknown) => MediaWatchHistoryItem[];
  parseActivityLogResponse: (data: unknown) => JellyfinEmbyActivityEntry[];
  parseItemsResponse: (data: unknown) => JellyfinEmbyItemResult[];
  parseUser: (data: Record<string, unknown>) => MediaUser;
  parseAuthResponse: (data: Record<string, unknown>) => JellyfinEmbyAuthResult;
  parseLibraryItemsResponse: (data: unknown[]) => MediaLibraryItem[];
}

/**
 * Abstract base client for Jellyfin and Emby media servers
 */
export abstract class BaseMediaServerClient
  implements IMediaServerClient, IMediaServerClientWithHistory, IMediaServerClientWithWatchSync
{
  /** Platform identifier for service tagging */
  public abstract readonly serverType: 'jellyfin' | 'emby';

  protected readonly baseUrl: string;
  protected readonly apiKey: string;

  /** Parser functions injected by subclass */
  protected abstract readonly parsers: MediaServerParsers;

  constructor(config: MediaServerConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.apiKey = config.token;
  }

  // ==========================================================================
  // Protected Helpers
  // ==========================================================================

  /**
   * Build X-Emby-Authorization header value
   * Used by both Jellyfin and Emby (identical format)
   */
  protected buildAuthHeader(): string {
    return `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}", Token="${this.apiKey}"`;
  }

  /**
   * Build headers for API requests
   */
  protected buildHeaders(): Record<string, string> {
    return {
      'X-Emby-Authorization': this.buildAuthHeader(),
      ...jellyfinEmbyHeaders(),
    };
  }

  // ==========================================================================
  // IMediaServerClient Implementation
  // ==========================================================================

  /**
   * Get all active playback sessions
   */
  async getSessions(): Promise<MediaSession[]> {
    const data = await fetchJson<unknown[]>(`${this.baseUrl}/Sessions`, {
      headers: this.buildHeaders(),
      service: this.serverType,
      timeout: 10000,
    });

    return this.parsers.parseSessionsResponse(data);
  }

  /**
   * Get all users on this server
   */
  async getUsers(): Promise<MediaUser[]> {
    const data = await fetchJson<unknown[]>(`${this.baseUrl}/Users`, {
      headers: this.buildHeaders(),
      service: this.serverType,
    });

    return this.parsers.parseUsersResponse(data);
  }

  /**
   * Get all libraries on this server
   */
  async getLibraries(): Promise<MediaLibrary[]> {
    const data = await fetchJson<unknown[]>(`${this.baseUrl}/Library/VirtualFolders`, {
      headers: this.buildHeaders(),
      service: this.serverType,
    });

    return this.parsers.parseLibrariesResponse(data);
  }

  /**
   * Test connection to the server
   */
  async testConnection(): Promise<boolean> {
    try {
      await fetchJson<unknown>(`${this.baseUrl}/System/Info`, {
        headers: this.buildHeaders(),
        service: this.serverType,
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all items in a library with pagination
   *
   * Uses /Items endpoint with ProviderIds field to get external IDs.
   *
   * @param libraryId - The parent library ID
   * @param options - Pagination options
   * @returns Items and total count for pagination tracking
   */
  async getLibraryItems(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;

    const params = new URLSearchParams({
      ParentId: libraryId,
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series,Season,Episode,MusicArtist,MusicAlbum,Audio',
      Fields:
        'ProviderIds,Path,MediaSources,DateCreated,ProductionYear,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,Album,AlbumArtist,Artists',
      StartIndex: String(offset),
      Limit: String(limit),
    });

    const data = await fetchJson<{ Items?: unknown[]; TotalRecordCount?: number }>(
      `${this.baseUrl}/Items?${params}`,
      {
        headers: this.buildHeaders(),
        service: this.serverType,
        timeout: 30000,
      }
    );

    const items = this.parsers.parseLibraryItemsResponse(data.Items ?? []);
    const totalCount = data.TotalRecordCount ?? items.length;

    return { items, totalCount };
  }

  // ==========================================================================
  // IMediaServerClientWithHistory Implementation
  // ==========================================================================

  /**
   * Get watch history for a specific user
   */
  async getWatchHistory(options?: {
    userId?: string;
    limit?: number;
  }): Promise<MediaWatchHistoryItem[]> {
    if (!options?.userId) {
      throw new Error(`${this.serverType} requires a userId for watch history`);
    }

    const params = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode',
      Filters: 'IsPlayed',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Limit: String(options.limit ?? 500),
      Fields: 'MediaSources',
    });

    const data = await fetchJson<unknown>(
      `${this.baseUrl}/Users/${options.userId}/Items?${params}`,
      {
        headers: this.buildHeaders(),
        service: this.serverType,
      }
    );

    return this.parsers.parseWatchHistoryResponse(data);
  }

  // ==========================================================================
  // Session Control
  // ==========================================================================

  /**
   * Send a message to a session's client device
   * Note: Not all clients support message display
   *
   * @param sessionId - The session to send the message to
   * @param text - The message content
   * @param header - Optional title/header for the message
   * @param timeoutMs - Auto-dismiss timeout in milliseconds (shows as toast if set)
   */
  async sendMessage(
    sessionId: string,
    text: string,
    header?: string,
    timeoutMs?: number
  ): Promise<boolean> {
    const params = new URLSearchParams();
    params.append('Text', text);
    if (header) params.append('Header', header);
    if (timeoutMs) params.append('TimeoutMs', String(timeoutMs));

    const response = await fetch(`${this.baseUrl}/Sessions/${sessionId}/Message?${params}`, {
      method: 'POST',
      headers: this.buildHeaders(),
    });

    // Best-effort: don't fail if client doesn't support messages or session ended
    return response.ok || response.status === 404;
  }

  /**
   * Terminate a playback session
   * If a reason is provided, sends it as a message to the user first
   */
  async terminateSession(sessionId: string, reason?: string): Promise<boolean> {
    // Send message to user before stopping (Emby/Jellyfin require separate API call)
    if (reason) {
      await this.sendMessage(sessionId, reason, 'Stream Terminated', 5000);
    }

    const response = await fetch(`${this.baseUrl}/Sessions/${sessionId}/Playing/Stop`, {
      method: 'POST',
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Unauthorized to terminate session');
      }
      if (response.status === 404) {
        throw new Error('Session not found (may have already ended)');
      }
      throw new Error(`Failed to terminate session: ${response.status} ${response.statusText}`);
    }

    return true;
  }

  // ==========================================================================
  // Shared Extended Methods
  // ==========================================================================

  /**
   * Batch fetch media items by their IDs
   */
  async getItems(ids: string[]): Promise<JellyfinEmbyItemResult[]> {
    if (ids.length === 0) return [];

    const params = new URLSearchParams({
      Ids: ids.join(','),
      // Include episode, movie, and music metadata fields
      Fields:
        'ProductionYear,ParentIndexNumber,IndexNumber,SeriesId,SeriesPrimaryImageTag,Album,AlbumArtist,Artists,AlbumId,AlbumPrimaryImageTag',
    });

    const data = await fetchJson<{ Items?: unknown[] }>(`${this.baseUrl}/Items?${params}`, {
      headers: this.buildHeaders(),
      service: this.serverType,
    });

    return this.parsers.parseItemsResponse(data);
  }

  /**
   * Get watch history for all users on the server
   */
  async getAllUsersWatchHistory(limit = 200): Promise<Map<string, MediaWatchHistoryItem[]>> {
    const allUsers = await this.getUsers();
    const historyMap = new Map<string, MediaWatchHistoryItem[]>();

    for (const user of allUsers) {
      if (user.isDisabled) continue;
      try {
        const history = await this.getWatchHistory({ userId: user.id, limit });
        historyMap.set(user.id, history);
      } catch (error) {
        console.error(`Failed to get history for user ${user.username}:`, error);
      }
    }

    return historyMap;
  }

  /**
   * Get activity log entries (requires admin)
   * Note: Query parameter casing differs between Jellyfin (lowercase) and Emby (PascalCase)
   */
  abstract getActivityLog(options?: {
    minDate?: Date;
    limit?: number;
    hasUserId?: boolean;
  }): Promise<JellyfinEmbyActivityEntry[]>;

  // ==========================================================================
  // IMediaServerClientWithWatchSync Implementation
  // ==========================================================================

  /**
   * Get all watched items for a user (movies and episodes)
   *
   * Fetches watched items with provider IDs for cross-server matching.
   *
   * @param userId - Jellyfin/Emby user ID
   * @param options - Optional filters
   */
  async getWatchedItems(
    userId: string,
    options?: {
      includeInProgress?: boolean;
      includeUnwatched?: boolean;
      libraryIds?: string[];
    }
  ): Promise<WatchedItem[]> {
    const PAGE_SIZE = 10000;
    const includeInProgress = options?.includeInProgress ?? true;
    const includeUnwatched = options?.includeUnwatched ?? false;
    const allItems: WatchedItem[] = [];

    // Build params for fetching items
    const baseParams = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode',
      Fields:
        'ProviderIds,Path,MediaSources,DateCreated,ParentId,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,RunTimeTicks,UserData',
      Limit: '10000',
    });

    // Fetch libraries to build path-to-name mapping for library name assignment
    const libraries = await this.getLibraries();
    const libraryIdToName = new Map<string, string>();
    const libraryPathToName: Array<{ path: string; name: string }> = [];
    for (const lib of libraries) {
      if (
        lib.type === 'movie' ||
        lib.type === 'movies' ||
        lib.type === 'show' ||
        lib.type === 'tvshows'
      ) {
        libraryIdToName.set(lib.id, lib.name);
        for (const location of lib.locations ?? []) {
          libraryPathToName.push({ path: location, name: lib.name });
        }
      }
    }
    // Sort by path length descending so longer/more specific paths match first
    libraryPathToName.sort((a, b) => b.path.length - a.path.length);

    // Add library filter if specified
    if (options?.libraryIds && options.libraryIds.length > 0) {
      baseParams.set('ParentId', options.libraryIds.join(','));
    }

    // Helper to find library name for an item
    const findLibraryName = (item: Record<string, unknown>): string | undefined => {
      const parentId = item.ParentId as string | undefined;
      if (parentId && libraryIdToName.has(parentId)) {
        return libraryIdToName.get(parentId);
      }
      const itemPath = item.Path as string | undefined;
      if (itemPath) {
        for (const { path, name } of libraryPathToName) {
          if (itemPath.startsWith(path)) {
            return name;
          }
        }
      }
      return undefined;
    };

    const fetchAllItems = async (
      params: URLSearchParams
    ): Promise<Array<Record<string, unknown>>> => {
      const items: Array<Record<string, unknown>> = [];
      let startIndex = 0;
      let totalCount: number | null = null;

      while (true) {
        const pageParams = new URLSearchParams(params);
        pageParams.set('StartIndex', String(startIndex));
        pageParams.set('Limit', String(PAGE_SIZE));

        const data = await fetchJson<{
          Items?: Array<Record<string, unknown>>;
          TotalRecordCount?: number;
        }>(`${this.baseUrl}/Users/${userId}/Items?${pageParams}`, {
          headers: this.buildHeaders(),
          service: this.serverType,
        });

        const pageItems = data?.Items ?? [];
        items.push(...pageItems);

        if (typeof data?.TotalRecordCount === 'number') {
          totalCount = data.TotalRecordCount;
        }

        if (pageItems.length === 0) {
          break;
        }

        if (totalCount !== null && startIndex + pageItems.length >= totalCount) {
          break;
        }

        if (pageItems.length < PAGE_SIZE) {
          break;
        }

        startIndex += pageItems.length;
      }

      return items;
    };

    // If includeUnwatched, fetch ALL items with pagination
    if (includeUnwatched) {
      try {
        const allData = await fetchAllItems(baseParams);

        for (const item of allData) {
          const watchedItem = this.parseWatchedItemWithState(item);
          if (watchedItem) {
            watchedItem.libraryName = findLibraryName(item);
            allItems.push(watchedItem);
          }
        }
      } catch (error) {
        console.error(`Failed to fetch all items for user ${userId}:`, error);
      }

      return allItems;
    }

    // Fetch watched and in-progress separately
    const watchedParams = new URLSearchParams(baseParams);
    watchedParams.set('IsPlayed', 'true');

    try {
      const watchedData = await fetchAllItems(watchedParams);

      for (const item of watchedData) {
        const watchedItem = this.parseWatchedItem(item, true);
        if (watchedItem) {
          watchedItem.libraryName = findLibraryName(item);
          allItems.push(watchedItem);
        }
      }
    } catch (error) {
      console.error(`Failed to fetch watched items for user ${userId}:`, error);
    }

    // Fetch in-progress items if requested
    if (includeInProgress) {
      const inProgressParams = new URLSearchParams(baseParams);
      inProgressParams.set('Filters', 'IsResumable');

      try {
        const inProgressData = await fetchAllItems(inProgressParams);

        for (const item of inProgressData) {
          const watchedItem = this.parseWatchedItem(item, false);
          if (watchedItem) {
            watchedItem.libraryName = findLibraryName(item);
            allItems.push(watchedItem);
          }
        }
      } catch (error) {
        console.error(`Failed to fetch in-progress items for user ${userId}:`, error);
      }
    }

    return allItems;
  }

  /**
   * Parse item with watch state from UserData (for includeUnwatched mode)
   */
  protected parseWatchedItemWithState(item: Record<string, unknown>): WatchedItem | null {
    const userData = (item.UserData ?? {}) as Record<string, unknown>;
    const played = (userData.Played as boolean) ?? false;

    // Determine completed state from UserData
    const completed = played;

    return this.parseWatchedItem(item, completed);
  }

  /**
   * Parse a Jellyfin/Emby item into a WatchedItem
   */
  protected parseWatchedItem(
    item: Record<string, unknown>,
    completed: boolean
  ): WatchedItem | null {
    const itemId = item.Id as string;
    if (!itemId) return null;

    const itemType = item.Type as string;
    const type: 'movie' | 'episode' = itemType === 'Movie' ? 'movie' : 'episode';

    // Extract provider IDs
    const providerIds = (item.ProviderIds ?? {}) as Record<string, string>;
    const imdbId = providerIds.Imdb ?? providerIds.imdb;
    const tmdbId = providerIds.Tmdb ?? providerIds.tmdb;
    const tvdbId = providerIds.Tvdb ?? providerIds.tvdb;

    // Get user data for progress info
    const userData = (item.UserData ?? {}) as Record<string, unknown>;
    const playbackPositionTicks = (userData.PlaybackPositionTicks as number) ?? 0;
    const lastPlayedDate = userData.LastPlayedDate as string | undefined;

    // Duration is in ticks (10,000 ticks = 1ms)
    const runTimeTicks = (item.RunTimeTicks as number) ?? 0;
    const durationMs = Math.floor(runTimeTicks / 10000);
    const progressMs = Math.floor(playbackPositionTicks / 10000);

    const fileNames = this.collectFileNames(item);

    const watchedItem: WatchedItem = {
      title: (item.Name as string) ?? '',
      type,
      year: (item.ProductionYear as number) ?? undefined,
      imdbId,
      tmdbId: tmdbId ? parseInt(tmdbId, 10) : undefined,
      tvdbId: tvdbId ? parseInt(tvdbId, 10) : undefined,
      fileNames: fileNames.length > 0 ? fileNames : undefined,
      completed,
      progressMs: completed ? durationMs : progressMs,
      totalDurationMs: durationMs,
      viewedAt: lastPlayedDate ? new Date(lastPlayedDate) : undefined,
      serverItemId: itemId,
    };

    // Add episode-specific info
    if (type === 'episode') {
      watchedItem.showTitle = (item.SeriesName as string) ?? undefined;
      watchedItem.seasonNumber = (item.ParentIndexNumber as number) ?? undefined;
      watchedItem.episodeNumber = (item.IndexNumber as number) ?? undefined;

      // Try to get show provider IDs (may need separate API call in some cases)
      // For now, we set them if available at the episode level
      const seriesProviderIds = (item.SeriesProviderIds ?? {}) as Record<string, string>;
      watchedItem.showImdbId = seriesProviderIds.Imdb ?? seriesProviderIds.imdb;
      watchedItem.showTmdbId = seriesProviderIds.Tmdb
        ? parseInt(seriesProviderIds.Tmdb, 10)
        : undefined;
      watchedItem.showTvdbId = seriesProviderIds.Tvdb
        ? parseInt(seriesProviderIds.Tvdb, 10)
        : undefined;
    }

    return watchedItem;
  }

  /**
   * Collect file names from available path fields (basenames only)
   */
  protected collectFileNames(item: Record<string, unknown>): string[] {
    const fileNames = new Set<string>();

    const addFileName = (value: unknown) => {
      if (typeof value !== 'string' || !value.trim()) return;
      const fileName = fileNameFromAnyPath(value);
      if (fileName) fileNames.add(fileName);
    };

    addFileName(item.Path);

    const mediaSources = item.MediaSources as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(mediaSources)) {
      for (const source of mediaSources) {
        addFileName(source.Path);
      }
    }

    return [...fileNames];
  }

  /**
   * Mark an item as watched (completed)
   *
   * Uses the Jellyfin/Emby PlayedItems endpoint.
   *
   * @param userId - User ID
   * @param itemId - The item ID to mark as watched
   * @param viewedAt - Optional timestamp when item was watched
   * @param _userToken - Ignored (Plex-specific, Jellyfin/Emby don't need it)
   */
  async markWatched(
    userId: string,
    itemId: string,
    viewedAt?: Date,
    _userToken?: string
  ): Promise<boolean> {
    // Build URL with optional DatePlayed parameter
    let url = `${this.baseUrl}/Users/${userId}/PlayedItems/${itemId}`;
    if (viewedAt) {
      const params = new URLSearchParams({
        DatePlayed: viewedAt.toISOString(),
      });
      url += `?${params}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
    });

    return response.ok;
  }

  /**
   * Update playback progress for partial watches
   *
   * Uses the Jellyfin/Emby UserData endpoint to update PlaybackPositionTicks.
   *
   * @param userId - User ID
   * @param itemId - The item ID
   * @param progressMs - Current playback position in milliseconds
   * @param _userToken - Ignored (Plex-specific, Jellyfin/Emby don't need it)
   */
  async updateProgress(
    userId: string,
    itemId: string,
    progressMs: number,
    _userToken?: string
  ): Promise<boolean> {
    // Convert milliseconds to ticks (10,000 ticks = 1ms)
    const positionTicks = progressMs * 10000;

    const response = await fetch(`${this.baseUrl}/Users/${userId}/Items/${itemId}/UserData`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        PlaybackPositionTicks: positionTicks,
      }),
    });

    return response.ok;
  }

  // ==========================================================================
  // Static Authentication Helpers
  // ==========================================================================

  /**
   * Build auth header for static authentication methods (no token yet)
   */
  protected static buildStaticAuthHeader(token?: string): string {
    const tokenPart = token ? `, Token="${token}"` : '';
    return `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}"${tokenPart}`;
  }
}
