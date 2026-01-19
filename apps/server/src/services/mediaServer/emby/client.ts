/**
 * Emby Media Server Client
 *
 * Implements IMediaServerClient for Emby servers.
 * Extends BaseMediaServerClient with Emby-specific authentication and activity log handling.
 *
 * Based on Emby OpenAPI specification v4.1.1.0
 */

import { fetchJson } from '../../../utils/http.js';
import {
  BaseMediaServerClient,
  type JellyfinEmbyActivityEntry,
  type JellyfinEmbyAuthResult,
  type JellyfinEmbyItemResult,
  type MediaServerParsers,
} from '../shared/baseMediaServerClient.js';
import {
  parseSessionsResponse,
  parseUsersResponse,
  parseLibrariesResponse,
  parseWatchHistoryResponse,
  parseActivityLogResponse,
  parseAuthResponse,
  parseItemsResponse,
  parseLibraryItemsResponse,
  parseUser,
} from './parser.js';

// Re-export types with platform-specific aliases for backward compatibility
export type EmbyActivityEntry = JellyfinEmbyActivityEntry;
export type EmbyAuthResult = JellyfinEmbyAuthResult;
export type EmbyItemResult = JellyfinEmbyItemResult;

/**
 * Emby Media Server client implementation
 *
 * @example
 * const client = new EmbyClient({ url: 'http://emby.local:8096', token: 'xxx' });
 * const sessions = await client.getSessions();
 */
export class EmbyClient extends BaseMediaServerClient {
  public readonly serverType = 'emby' as const;

  protected readonly parsers: MediaServerParsers = {
    parseSessionsResponse,
    parseUsersResponse,
    parseLibrariesResponse,
    parseWatchHistoryResponse,
    parseActivityLogResponse,
    parseItemsResponse,
    parseLibraryItemsResponse,
    parseUser,
    parseAuthResponse,
  };

  // ==========================================================================
  // Emby-Specific: Activity Log (PascalCase query params)
  // ==========================================================================

  /**
   * Get activity log entries (requires admin)
   *
   * Note: Emby uses PascalCase query parameters (Limit, MinDate, HasUserId)
   */
  async getActivityLog(options?: {
    minDate?: Date;
    limit?: number;
    hasUserId?: boolean;
  }): Promise<EmbyActivityEntry[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.append('Limit', String(options.limit));
    if (options?.minDate) params.append('MinDate', options.minDate.toISOString());
    if (options?.hasUserId !== undefined) params.append('HasUserId', String(options.hasUserId));

    const data = await fetchJson<unknown>(`${this.baseUrl}/System/ActivityLog/Entries?${params}`, {
      headers: this.buildHeaders(),
      service: 'emby',
    });

    return parseActivityLogResponse(data);
  }

  // ==========================================================================
  // Static Methods - Authentication (Emby-specific)
  // ==========================================================================

  /**
   * Authenticate with username/password
   * Note: Emby uses 'Password' field (not 'Pw' like Jellyfin)
   */
  static async authenticate(
    serverUrl: string,
    username: string,
    password: string
  ): Promise<EmbyAuthResult | null> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = BaseMediaServerClient.buildStaticAuthHeader();

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
          Password: password, // Emby uses 'Password', not 'Pw'
        }),
        service: 'emby',
      });

      return parseAuthResponse(data);
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Verify if API key has admin access to an Emby server
   *
   * Handles two token types:
   * 1. User tokens (from AuthenticateByName) - verified via /Users/Me
   * 2. API keys (created in Emby admin) - verified via /Auth/Keys (requires admin)
   */
  static async verifyServerAdmin(apiKey: string, serverUrl: string): Promise<boolean> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = BaseMediaServerClient.buildStaticAuthHeader(apiKey);

    const headers = {
      'X-Emby-Authorization': authHeader,
      Accept: 'application/json',
    };

    // Try /Users/Me first (works for user tokens from authentication)
    try {
      const data = await fetchJson<Record<string, unknown>>(`${url}/Users/Me`, {
        headers,
        service: 'emby',
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
        service: 'emby',
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
