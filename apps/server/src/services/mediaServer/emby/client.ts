/**
 * Emby Media Server Client
 *
 * Implements IMediaServerClient for Emby servers.
 * Extends BaseMediaServerClient with Emby-specific authentication and activity log handling.
 *
 * Based on Emby OpenAPI specification v4.1.1.0
 */

import { fetchJson, HttpClientError } from '../../../utils/http.js';
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

  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  /**
   * Verify that a token has admin access to an Emby server.
   *
   * User tokens (from AuthenticateByName) answer /Users/Me; API keys get a
   * 500 there on Emby 4.9 and are verified via /Auth/Keys, which only admin
   * keys can read.
   */
  static async verifyServerAdmin(
    apiKey: string,
    serverUrl: string
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    const url = serverUrl.replace(/\/$/, '');

    const headers = {
      'X-Emby-Authorization': BaseMediaServerClient.buildStaticAuthHeader(apiKey),
      Accept: 'application/json',
    };

    try {
      await fetchJson<unknown>(`${url}/System/Info/Public`, {
        headers: { Accept: 'application/json' },
        service: 'emby',
        timeout: 10000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to connect to server';
      return {
        success: false,
        code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot reach Emby server at ${url}. ${message}`,
      };
    }

    try {
      const data = await fetchJson<Record<string, unknown>>(`${url}/Users/Me`, {
        headers,
        service: 'emby',
        timeout: 10000,
      });

      const user = parseUser(data);
      if (user.isAdmin) {
        return { success: true };
      }
      return {
        success: false,
        code: EmbyClient.AdminVerifyError.NOT_ADMIN,
        message: 'This Emby account is not an administrator.',
      };
    } catch (error) {
      if (error instanceof HttpClientError && error.statusCode === 401) {
        return {
          success: false,
          code: EmbyClient.AdminVerifyError.INVALID_KEY,
          message: 'Emby rejected this API key (it may be invalid or expired).',
        };
      }
    }

    try {
      await fetchJson<unknown>(`${url}/Auth/Keys`, {
        headers,
        service: 'emby',
        timeout: 10000,
      });
      return { success: true };
    } catch (error) {
      if (error instanceof HttpClientError) {
        if (error.statusCode === 401) {
          return {
            success: false,
            code: EmbyClient.AdminVerifyError.INVALID_KEY,
            message: 'Emby rejected this API key (it may be invalid or expired).',
          };
        }
        if (error.statusCode === 403) {
          return {
            success: false,
            code: EmbyClient.AdminVerifyError.NOT_ADMIN,
            message: 'This API key does not have administrator access on this Emby server.',
          };
        }
      }
      const message = error instanceof Error ? error.message : 'Unable to verify admin access';
      return {
        success: false,
        code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Could not verify admin access on Emby server at ${url}. ${message}`,
      };
    }
  }
}
