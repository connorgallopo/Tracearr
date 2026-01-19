/**
 * Jellyfin Media Server Client
 *
 * Implements IMediaServerClient for Jellyfin servers.
 * Extends BaseMediaServerClient with Jellyfin-specific authentication and activity log handling.
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
export type JellyfinActivityEntry = JellyfinEmbyActivityEntry;
export type JellyfinAuthResult = JellyfinEmbyAuthResult;
export type JellyfinItemResult = JellyfinEmbyItemResult;

/**
 * Jellyfin Media Server client implementation
 *
 * @example
 * const client = new JellyfinClient({ url: 'http://jellyfin.local:8096', token: 'xxx' });
 * const sessions = await client.getSessions();
 */
export class JellyfinClient extends BaseMediaServerClient {
  public readonly serverType = 'jellyfin' as const;

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
  // Jellyfin-Specific: Activity Log (lowercase query params)
  // ==========================================================================

  /**
   * Get activity log entries (requires admin)
   *
   * Note: Jellyfin uses lowercase query parameters (limit, minDate, hasUserId)
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
  // Static Methods - Authentication (Jellyfin-specific)
  // ==========================================================================

  /**
   * Authenticate with username/password
   * Note: Jellyfin uses 'Pw' field for password
   */
  static async authenticate(
    serverUrl: string,
    username: string,
    password: string
  ): Promise<JellyfinAuthResult | null> {
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
          Pw: password, // Jellyfin uses 'Pw', not 'Password'
        }),
        service: 'jellyfin',
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
   * Error types for server admin verification
   */
  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  /**
   * Verify if token has admin access to a Jellyfin server
   *
   * Handles two token types:
   * 1. User tokens (from AuthenticateByName) - verified via /Users/Me
   * 2. API keys (created in Jellyfin admin) - verified via /Auth/Keys (requires admin)
   *
   * @returns { success: true } if admin access verified
   * @returns { success: false, code, message } if verification failed
   */
  static async verifyServerAdmin(
    apiKey: string,
    serverUrl: string
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = BaseMediaServerClient.buildStaticAuthHeader(apiKey);

    const headers = {
      'X-Emby-Authorization': authHeader,
      Accept: 'application/json',
    };

    // First verify basic server connectivity
    try {
      await fetchJson<unknown>(`${url}/System/Info/Public`, {
        headers: { Accept: 'application/json' },
        service: 'jellyfin',
        timeout: 10000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to connect to server';
      return {
        success: false,
        code: JellyfinClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot reach Jellyfin server at ${url}. ${message}`,
      };
    }

    // Try /Users/Me first (works for user tokens from authentication)
    try {
      const data = await fetchJson<Record<string, unknown>>(`${url}/Users/Me`, {
        headers,
        service: 'jellyfin',
        timeout: 10000,
      });

      const user = parseUser(data);
      if (user.isAdmin) {
        return { success: true };
      }
      return {
        success: false,
        code: JellyfinClient.AdminVerifyError.NOT_ADMIN,
        message: 'You must be an admin on this Jellyfin server',
      };
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
      return { success: true };
    } catch {
      return {
        success: false,
        code: JellyfinClient.AdminVerifyError.NOT_ADMIN,
        message: 'API key does not have admin access on this Jellyfin server',
      };
    }
  }
}
