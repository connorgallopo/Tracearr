/**
 * Base Media Server Client for Jellyfin/Emby
 *
 * Provides shared functionality for both platforms, which have nearly identical APIs.
 * Platform-specific differences (stream decisions, lastPausedDate, activity log params)
 * are handled by abstract methods or configuration.
 */

import { fetchJson, jellyfinEmbyHeaders } from '../../../utils/http.js';
import type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaWatchHistoryItem,
  MediaServerConfig,
} from '../types.js';

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
   * Terminate a playback session by sending a Stop command
   */
  async terminateSession(sessionId: string, _reason?: string): Promise<boolean> {
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
      Fields: 'ProductionYear,ParentIndexNumber,IndexNumber,SeriesId,SeriesPrimaryImageTag',
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
