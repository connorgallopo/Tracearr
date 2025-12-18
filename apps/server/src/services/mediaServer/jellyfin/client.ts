/**
 * Jellyfin Media Server Client
 *
 * Implements IMediaServerClient for Jellyfin servers.
 * Provides a unified interface for session tracking, user management, and library access.
 */

import { fetchJson, jellyfinHeaders } from '../../../utils/http.js';
import type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaWatchHistoryItem,
  MediaServerConfig,
} from '../types.js';
import {
  parseSessionsResponse,
  parseUsersResponse,
  parseLibrariesResponse,
  parseWatchHistoryResponse,
  parseActivityLogResponse,
  parseAuthResponse,
  parseUser,
  type JellyfinActivityEntry,
  type JellyfinAuthResult,
} from './parser.js';

const CLIENT_NAME = 'Tracearr';
const CLIENT_VERSION = '1.0.0';
const DEVICE_ID = 'tracearr-server';
const DEVICE_NAME = 'Tracearr Server';

/**
 * Jellyfin Media Server client implementation
 *
 * @example
 * const client = new JellyfinClient({ url: 'http://jellyfin.local:8096', token: 'xxx' });
 * const sessions = await client.getSessions();
 */
export class JellyfinClient implements IMediaServerClient, IMediaServerClientWithHistory {
  public readonly serverType = 'jellyfin' as const;

  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: MediaServerConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.apiKey = config.token;
  }

  /**
   * Build X-Emby-Authorization header value
   */
  private buildAuthHeader(): string {
    return `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}", Token="${this.apiKey}"`;
  }

  /**
   * Build headers for Jellyfin API requests
   */
  private buildHeaders(): Record<string, string> {
    return {
      'X-Emby-Authorization': this.buildAuthHeader(),
      ...jellyfinHeaders(),
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
      service: 'jellyfin',
      timeout: 10000, // 10s timeout to prevent polling hangs
    });

    return parseSessionsResponse(data);
  }

  /**
   * Get all users on this server
   */
  async getUsers(): Promise<MediaUser[]> {
    const data = await fetchJson<unknown[]>(`${this.baseUrl}/Users`, {
      headers: this.buildHeaders(),
      service: 'jellyfin',
    });

    return parseUsersResponse(data);
  }

  /**
   * Get all libraries on this server
   */
  async getLibraries(): Promise<MediaLibrary[]> {
    const data = await fetchJson<unknown[]>(`${this.baseUrl}/Library/VirtualFolders`, {
      headers: this.buildHeaders(),
      service: 'jellyfin',
    });

    return parseLibrariesResponse(data);
  }

  /**
   * Test connection to the server
   */
  async testConnection(): Promise<boolean> {
    try {
      await fetchJson<unknown>(`${this.baseUrl}/System/Info`, {
        headers: this.buildHeaders(),
        service: 'jellyfin',
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
   *
   * Note: Unlike Tautulli, this only returns WHAT was watched, not session details.
   * For full session history, users would need Jellystat or the Playback Reporting plugin.
   */
  async getWatchHistory(options?: {
    userId?: string;
    limit?: number;
  }): Promise<MediaWatchHistoryItem[]> {
    if (!options?.userId) {
      throw new Error('Jellyfin requires a userId for watch history');
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
        service: 'jellyfin',
      }
    );

    return parseWatchHistoryResponse(data);
  }

  // ==========================================================================
  // Session Control
  // ==========================================================================

  /**
   * Terminate a playback session by sending a Stop command
   *
   * @param sessionId - The session ID (same as sessionKey for Jellyfin)
   * @param _reason - Ignored (Jellyfin doesn't support user-facing messages)
   * @returns true if successful, throws on error
   *
   * @example
   * await client.terminateSession('session-uuid-123');
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
  // Jellyfin-Specific Methods
  // ==========================================================================

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
   *
   * Activity types to watch for:
   * - AuthenticationSucceeded - Successful login
   * - AuthenticationFailed - Failed login attempt
   * - SessionStarted - New session
   * - SessionEnded - Session ended
   */
  async getActivityLog(options?: {
    minDate?: Date;
    limit?: number;
    hasUserId?: boolean;
  }): Promise<JellyfinActivityEntry[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.append('limit', String(options.limit));
    if (options?.minDate) params.append('minDate', options.minDate.toISOString());
    if (options?.hasUserId !== undefined) params.append('hasUserId', String(options.hasUserId));

    const data = await fetchJson<unknown>(`${this.baseUrl}/System/ActivityLog/Entries?${params}`, {
      headers: this.buildHeaders(),
      service: 'jellyfin',
    });

    return parseActivityLogResponse(data);
  }

  // ==========================================================================
  // Static Methods - Authentication
  // ==========================================================================

  /**
   * Authenticate with username/password
   */
  static async authenticate(
    serverUrl: string,
    username: string,
    password: string
  ): Promise<JellyfinAuthResult | null> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}"`;

    try {
      const data = await fetchJson<Record<string, unknown>>(`${url}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
          'X-Emby-Authorization': authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          Username: username,
          Pw: password,
        }),
        service: 'jellyfin',
      });

      return parseAuthResponse(data);
    } catch (error) {
      // Return null for auth failures, rethrow other errors
      if (error instanceof Error && error.message.includes('401')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Verify if token has admin access to a Jellyfin server
   *
   * Handles two token types:
   * 1. User tokens (from AuthenticateByName) - verified via /Users/Me
   * 2. API keys (created in Jellyfin admin) - verified via /Auth/Keys (requires admin)
   */
  static async verifyServerAdmin(apiKey: string, serverUrl: string): Promise<boolean> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}", Token="${apiKey}"`;

    const headers = {
      'X-Emby-Authorization': authHeader,
      Accept: 'application/json',
    };

    // Try /Users/Me first (works for user tokens from authentication)
    try {
      const data = await fetchJson<Record<string, unknown>>(`${url}/Users/Me`, {
        headers,
        service: 'jellyfin',
        timeout: 10000,
      });

      const user = parseUser(data);
      return user.isAdmin;
    } catch {
      // /Users/Me returns 400 for API keys (not user tokens)
      // Fall through to try /Auth/Keys
    }

    // Try /Auth/Keys (only accessible with admin-level API keys)
    try {
      await fetchJson<unknown>(`${url}/Auth/Keys`, {
        headers,
        service: 'jellyfin',
        timeout: 10000,
      });
      // If we can access /Auth/Keys, the token has admin access
      return true;
    } catch {
      return false;
    }
  }
}
