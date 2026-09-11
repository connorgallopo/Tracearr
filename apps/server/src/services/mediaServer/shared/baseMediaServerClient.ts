/**
 * Base Media Server Client for Jellyfin/Emby
 *
 * Provides shared functionality for both platforms, which have nearly identical APIs.
 * Platform-specific differences (stream decisions, lastPausedDate, activity log params)
 * are handled by abstract methods or configuration.
 */

import { fetchJson, jellyfinEmbyHeaders, HttpClientError } from '../../../utils/http.js';
import type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaLibraryItem,
  MediaWatchHistoryItem,
  MediaServerConfig,
} from '../types.js';

// Client identification constants
const CLIENT_NAME = 'Tracearr';
const CLIENT_VERSION = '1.0.0';
const DEVICE_ID = 'tracearr-server';
const DEVICE_NAME = 'Tracearr Server';

// MusicArtist is only requested for music libraries: Jellyfin 12 answers it
// with every artist on the server whatever ParentId the query names
const LIBRARY_ITEM_TYPES: Record<string, string> = {
  movies: 'Movie',
  tvshows: 'Series',
  music: 'MusicArtist,MusicAlbum,Audio',
};
const DEFAULT_LIBRARY_ITEM_TYPES = 'Movie,Series,MusicAlbum,Audio';
// Leaves included: the existence check covers every row a scan tracks for the
// library, and must not answer for types the library never lists (an artist
// filed under a video library by the leak above stays gone)
const LIBRARY_ALL_ITEM_TYPES: Record<string, string> = {
  movies: 'Movie',
  tvshows: 'Series,Season,Episode',
  music: 'MusicArtist,MusicAlbum,Audio',
};
const DEFAULT_ALL_ITEM_TYPES = 'Movie,Series,Season,Episode,MusicArtist,MusicAlbum,Audio';
const ID_LOOKUP_BATCH_SIZE = 100;

function libraryItemTypes(libraryType?: string): string {
  return LIBRARY_ITEM_TYPES[(libraryType ?? '').toLowerCase()] ?? DEFAULT_LIBRARY_ITEM_TYPES;
}

function libraryAllItemTypes(libraryType?: string): string {
  return LIBRARY_ALL_ITEM_TYPES[(libraryType ?? '').toLowerCase()] ?? DEFAULT_ALL_ITEM_TYPES;
}

export function buildJellyfinEmbyAuthHeader(token: string): string {
  return `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}", Token="${token}"`;
}

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
  RunTimeTicks?: number;
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
  implements IMediaServerClient, IMediaServerClientWithHistory
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
   * Build the MediaBrowser auth scheme value (identical format for Jellyfin and Emby)
   */
  protected buildAuthHeader(): string {
    return buildJellyfinEmbyAuthHeader(this.apiKey);
  }

  /**
   * Build headers for API requests
   */
  protected buildHeaders(): Record<string, string> {
    const authHeaderName =
      this.serverType === 'jellyfin' ? 'Authorization' : 'X-Emby-Authorization';
    return {
      [authHeaderName]: this.buildAuthHeader(),
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
   * The body both `getServerIdentity` and `getSoftwareVersion` read their one field from.
   */
  private async systemInfo(): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(`${this.baseUrl}/System/Info`, {
      headers: this.buildHeaders(),
      service: this.serverType,
      timeout: 10000,
    });
  }

  /**
   * The server's own id. Jellyfin item links resolve without it; an Emby web deep link
   * without its `serverId` param 404s.
   */
  async getServerIdentity(): Promise<string | null> {
    const { Id } = await this.systemInfo();
    return typeof Id === 'string' && Id ? Id : null;
  }

  /** The version the server reports for itself, as the update checker compares it. */
  async getSoftwareVersion(): Promise<string | null> {
    const { Version } = await this.systemInfo();
    return typeof Version === 'string' && Version ? Version : null;
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
    options?: { offset?: number; limit?: number; libraryType?: string }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount: number }> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;

    const params = new URLSearchParams({
      ParentId: libraryId,
      Recursive: 'true',
      // Episode and Season: fetched separately via getLibraryLeaves() to avoid
      // double-counting and to keep this query's totalCount top-level-only
      IncludeItemTypes: libraryItemTypes(options?.libraryType),
      // Jellyfin 12 otherwise folds collection members into their BoxSet and
      // leaves the movies themselves out of the listing
      CollapseBoxSetItems: 'false',
      // IsMissing=false excludes "missing" items that Jellyfin/Emby knows about from metadata
      // but the user doesn't have files for (fixes #240 - inflated episode counts)
      IsMissing: 'false',
      Fields:
        'ProviderIds,Path,MediaSources,DateCreated,ProductionYear,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,Album,AlbumArtist,Artists,AlbumId,AlbumPrimaryImageTag,Genres,ImageTags',
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

    const rawCount = (data.Items ?? []).length;
    const items = this.parsers.parseLibraryItemsResponse(data.Items ?? []);
    const totalCount = data.TotalRecordCount ?? items.length;

    return { items, totalCount, rawCount };
  }

  /**
   * Get library items modified since a given date
   *
   * Sorts by DateCreated descending and filters client-side. This works around
   * Jellyfin/Emby's minDateLastSaved filter being unreliable (DateLastSaved is
   * often unpopulated). We keep minDateLastSaved in the query so future server
   * versions that fix the field will do the filtering server-side too.
   *
   * Handles its own pagination internally — the caller's offset/limit are ignored.
   *
   * @param libraryId - The parent library ID
   * @param since - Only return items added after this date
   * @returns Items and total count for pagination tracking
   */
  async getLibraryItemsSince(
    libraryId: string,
    since: Date,
    options?: { offset?: number; limit?: number; libraryType?: string }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const PAGE_SIZE = 200;
    const allItems: MediaLibraryItem[] = [];
    let serverOffset = 0;

    while (true) {
      const params = new URLSearchParams({
        ParentId: libraryId,
        Recursive: 'true',
        IncludeItemTypes: libraryItemTypes(options?.libraryType),
        CollapseBoxSetItems: 'false',
        IsMissing: 'false',
        Fields:
          'ProviderIds,Path,MediaSources,DateCreated,ProductionYear,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,Album,AlbumArtist,Artists,AlbumId,AlbumPrimaryImageTag,Genres,ImageTags',
        StartIndex: String(serverOffset),
        Limit: String(PAGE_SIZE),
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        minDateLastSaved: since.toISOString(),
      });

      const data = await fetchJson<{ Items?: unknown[]; TotalRecordCount?: number }>(
        `${this.baseUrl}/Items?${params}`,
        {
          headers: this.buildHeaders(),
          service: this.serverType,
          timeout: 30000,
        }
      );

      // StartIndex is a raw server-side offset, so the page-empty check and the
      // offset advance must both use the raw count, not the post-extras-filter count
      const rawCount = (data.Items ?? []).length;
      if (rawCount === 0) break;
      const parsedItems = this.parsers.parseLibraryItemsResponse(data.Items ?? []);

      const filtered = parsedItems.filter((item) => item.addedAt >= since);
      allItems.push(...filtered);

      // If some items on this page predate `since`, we've passed the cutoff
      if (filtered.length < parsedItems.length) break;

      serverOffset += rawCount;
    }

    return { items: allItems, totalCount: allItems.length };
  }

  /**
   * Get all episodes and seasons (leaves) in a TV library with pagination
   *
   * For TV libraries, this fetches Episode and Season items, separate from
   * Series. This matches Plex behavior where episodes are fetched via
   * /allLeaves and seasons via a type=3 query, both apart from the top-level
   * /all fetch. Season rides this call instead of getLibraryItems so that
   * call's totalCount - used for the sync count-mismatch check - stays
   * top-level-only.
   *
   * Fixes #263: Emby not reporting all TV episodes when using getLibraryItems alone.
   *
   * @param libraryId - The parent library ID
   * @param options - Pagination options
   * @returns Episodes/seasons and total count for pagination tracking
   */
  async getLibraryLeaves(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount: number }> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;

    const params = new URLSearchParams({
      ParentId: libraryId,
      Recursive: 'true',
      IncludeItemTypes: 'Episode,Season',
      IsMissing: 'false',
      Fields:
        'ProviderIds,Path,MediaSources,DateCreated,ProductionYear,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,Genres,ImageTags',
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

    const rawCount = (data.Items ?? []).length;
    const items = this.parsers.parseLibraryItemsResponse(data.Items ?? []);
    const totalCount = data.TotalRecordCount ?? items.length;

    return { items, totalCount, rawCount };
  }

  /**
   * Get episodes modified since a given date
   *
   * Same approach as getLibraryItemsSince — sorts by DateCreated descending
   * and filters client-side to work around unreliable minDateLastSaved.
   *
   * @param libraryId - The parent library ID
   * @param since - Only return episodes added after this date
   * @returns Episodes and total count for pagination tracking
   */
  async getLibraryLeavesSince(
    libraryId: string,
    since: Date,
    _options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const PAGE_SIZE = 200;
    const allItems: MediaLibraryItem[] = [];
    let serverOffset = 0;

    while (true) {
      const params = new URLSearchParams({
        ParentId: libraryId,
        Recursive: 'true',
        IncludeItemTypes: 'Episode,Season',
        IsMissing: 'false',
        Fields:
          'ProviderIds,Path,MediaSources,DateCreated,ProductionYear,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,Genres,ImageTags',
        StartIndex: String(serverOffset),
        Limit: String(PAGE_SIZE),
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        minDateLastSaved: since.toISOString(),
      });

      const data = await fetchJson<{ Items?: unknown[]; TotalRecordCount?: number }>(
        `${this.baseUrl}/Items?${params}`,
        {
          headers: this.buildHeaders(),
          service: this.serverType,
          timeout: 30000,
        }
      );

      const rawCount = (data.Items ?? []).length;
      if (rawCount === 0) break;
      const parsedItems = this.parsers.parseLibraryItemsResponse(data.Items ?? []);

      const filtered = parsedItems.filter((item) => item.addedAt >= since);
      allItems.push(...filtered);

      if (filtered.length < parsedItems.length) break;

      serverOffset += rawCount;
    }

    return { items: allItems, totalCount: allItems.length };
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
      // IsMissing=false excludes "missing" items (fixes #240)
      IsMissing: 'false',
      Filters: 'IsPlayed',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Limit: String(options.limit ?? 500),
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
    const response = await fetch(`${this.baseUrl}/Sessions/${sessionId}/Message`, {
      method: 'POST',
      body: JSON.stringify({ Text: text, Header: header, TimeoutMs: timeoutMs }),
      headers: {
        'Content-Type': 'application/json',
        ...this.buildHeaders(),
      },
      // Bounds the call so an unresponsive server can't wedge the kill worker.
      signal: AbortSignal.timeout(10000),
    });

    // Best-effort: don't fail if client doesn't support messages or session ended
    return response.ok || response.status === 404;
  }

  /**
   * Look up a live session's remote-control capability.
   * Playback commands only take effect on clients that report SupportsMediaControl.
   */
  private async getSessionControlInfo(
    sessionId: string
  ): Promise<{ found: boolean; supportsMediaControl: boolean }> {
    const sessions = await fetchJson<Array<Record<string, unknown>>>(`${this.baseUrl}/Sessions`, {
      headers: this.buildHeaders(),
      service: this.serverType,
      timeout: 10000,
    });

    const match = Array.isArray(sessions) ? sessions.find((s) => s.Id === sessionId) : undefined;

    if (!match) return { found: false, supportsMediaControl: false };
    // Emby sessions only ever carry SupportsRemoteControl; Jellyfin sends both.
    return {
      found: true,
      supportsMediaControl:
        match.SupportsMediaControl === true || match.SupportsRemoteControl === true,
    };
  }

  /**
   * Terminate a playback session
   * If a reason is provided, sends it as a message to the user first
   */
  async terminateSession(sessionId: string, reason?: string): Promise<boolean> {
    // A Stop command is silently ignored by clients that aren't remote-controllable, so verify
    // capability first rather than reporting a false success.
    const control = await this.getSessionControlInfo(sessionId);
    if (!control.found) {
      throw new Error('Session not found (may have already ended)');
    }
    if (!control.supportsMediaControl) {
      throw new Error('Client does not support remote control; stream cannot be terminated');
    }

    // Send message to user before stopping (Emby/Jellyfin require separate API call)
    if (reason) {
      await this.sendMessage(sessionId, reason, 'Stream Terminated', 5000);
    }

    const response = await fetch(`${this.baseUrl}/Sessions/${sessionId}/Playing/Stop`, {
      method: 'POST',
      headers: this.buildHeaders(),
      // Bounds the call so an unresponsive server can't wedge the kill worker.
      signal: AbortSignal.timeout(10000),
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
   * Which of the given item ids the server still has as items a library of
   * this type holds. Virtual items (metadata without a file) count as gone,
   * matching the IsMissing=false listings.
   */
  async findExistingRatingKeys(
    ratingKeys: string[],
    library: { id: string; type: string }
  ): Promise<Set<string>> {
    const existing = new Set<string>();
    for (let start = 0; start < ratingKeys.length; start += ID_LOOKUP_BATCH_SIZE) {
      const params = new URLSearchParams({
        Ids: ratingKeys.slice(start, start + ID_LOOKUP_BATCH_SIZE).join(','),
        IncludeItemTypes: libraryAllItemTypes(library.type),
        IsMissing: 'false',
      });
      const data = await fetchJson<{ Items?: Array<{ Id?: string; LocationType?: string }> }>(
        `${this.baseUrl}/Items?${params}`,
        { headers: this.buildHeaders(), service: this.serverType, timeout: 30000 }
      );
      for (const item of data.Items ?? []) {
        if (item.Id && item.LocationType !== 'Virtual') existing.add(item.Id);
      }
    }
    return existing;
  }

  /**
   * Batch fetch media items by their IDs
   */
  async getItems(ids: string[]): Promise<JellyfinEmbyItemResult[]> {
    if (ids.length === 0) return [];

    const params = new URLSearchParams({
      Ids: ids.join(','),
      // Include episode, movie, and music metadata fields
      Fields:
        'ProductionYear,ParentIndexNumber,IndexNumber,SeriesId,SeriesPrimaryImageTag,Album,AlbumArtist,Artists,AlbumId,AlbumPrimaryImageTag,RunTimeTicks',
    });

    const data = await fetchJson<{ Items?: unknown[] }>(`${this.baseUrl}/Items?${params}`, {
      headers: this.buildHeaders(),
      service: this.serverType,
    });

    return this.parsers.parseItemsResponse(data);
  }

  private static readonly PLAYBACK_REPORTING_PATHS = {
    jellyfin: '/user_usage_stats/submit_custom_query',
    emby: '/emby/user_usage_stats/submit_custom_query',
  } as const;

  /**
   * Run a SQL query against the Playback Reporting plugin's SQLite database.
   * Requires the plugin; a missing plugin surfaces as HttpClientError 404.
   */
  async queryPlaybackReporting(query: string): Promise<string[][]> {
    const path = BaseMediaServerClient.PLAYBACK_REPORTING_PATHS[this.serverType];
    const data = await fetchJson<{ results?: unknown; message?: string }>(
      `${this.baseUrl}${path}`,
      {
        method: 'POST',
        headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ CustomQueryString: query }),
        service: this.serverType,
      }
    );
    const results = Array.isArray(data.results) ? (data.results as string[][]) : [];
    if (results.length === 0 && data.message?.startsWith('Error')) {
      throw new Error(`Playback Reporting query failed: ${data.message}`);
    }
    return results;
  }

  async getPlaybackReportingInfo(): Promise<
    | { installed: false }
    | {
        installed: true;
        columns: string[];
        totalRecords: number;
        oldestDate: string | null;
        newestDate: string | null;
      }
  > {
    let pragma: string[][];
    try {
      pragma = await this.queryPlaybackReporting("pragma table_info('PlaybackActivity')");
    } catch (error) {
      if (error instanceof HttpClientError && error.statusCode === 404) {
        return { installed: false };
      }
      throw error;
    }
    const columns = pragma.map((row) => row[1] ?? '').filter(Boolean);
    const summary = await this.queryPlaybackReporting(
      'SELECT COUNT(1), MIN(DateCreated), MAX(DateCreated) FROM PlaybackActivity'
    );
    const first = summary[0];
    return {
      installed: true,
      columns,
      totalRecords: first?.[0] ? Number(first[0]) : 0,
      oldestDate: first?.[1] || null,
      newestDate: first?.[2] || null,
    };
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
