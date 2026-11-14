/**
 * Jellyfin Media Server Client
 *
 * Implements IMediaServerClient for Jellyfin servers.
 * Extends BaseMediaServerClient with Jellyfin-specific authentication and activity log handling.
 */

import { fetchJson, HttpClientError, isHttpStatus } from '../../../utils/http.js';
import { assertSafeProbeUrl, probeRefusal } from '../../../utils/ssrf.js';
import type { MediaServerAuth } from '../types.js';
import {
  BaseMediaServerClient,
  type JellyfinEmbyActivityEntry,
  type JellyfinEmbyItemResult,
  type MediaServerParsers,
} from '../shared/baseMediaServerClient.js';
import {
  parseSessionsResponse,
  parseUsersResponse,
  parseLibrariesResponse,
  parseWatchHistoryResponse,
  parseActivityLogResponse,
  parseItemsResponse,
  parseLibraryItemsResponse,
  parseUser,
} from './parser.js';
import type { DeviceSession } from '../shared/jellyfinEmbyParser.js';

// Re-export types with platform-specific aliases for backward compatibility
export type JellyfinActivityEntry = JellyfinEmbyActivityEntry;
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

  override async getTranscodePullSessions(): Promise<DeviceSession[]> {
    return this.getDeviceSessions();
  }

  // ==========================================================================
  // Static Methods - Authentication (Jellyfin-specific)
  // ==========================================================================

  /**
   * Error types for server admin verification
   */
  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  // Jellyfin ignores X-Emby-Authorization and X-Emby-Token unless legacy authorization is on, so
  // everything goes in Authorization. Member-token calls send the token alone, so no Client or
  // Device field can overwrite what the member's device record holds from the sign-in.
  private static memberTokenHeader(token: string): Record<string, string> {
    return { Authorization: `MediaBrowser Token="${token}"` };
  }

  // Pw, not Password: the field name Jellyfin's AuthenticateByName body uses.
  static authenticateByName(
    serverUrl: string,
    username: string,
    pw: string,
    deviceId: string,
    forwardedFor: string
  ): Promise<MediaServerAuth | null> {
    return BaseMediaServerClient.requestUserToken(
      'jellyfin',
      serverUrl,
      '/Users/AuthenticateByName',
      {
        Authorization: BaseMediaServerClient.memberClientHeader('MediaBrowser', deviceId),
        ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
      },
      { Username: username, Pw: pw }
    );
  }

  static async quickConnectEnabled(serverUrl: string): Promise<boolean> {
    try {
      assertSafeProbeUrl(serverUrl);
      const enabled = await fetchJson<unknown>(
        `${serverUrl.replace(/\/$/, '')}/QuickConnect/Enabled`,
        {
          headers: { Accept: 'application/json' },
          service: 'jellyfin',
          timeout: 5_000,
          redirect: 'manual',
        }
      );
      return enabled === true;
    } catch {
      return false;
    }
  }

  static async quickConnectInitiate(
    serverUrl: string,
    deviceId: string
  ): Promise<{ secret: string; code: string }> {
    assertSafeProbeUrl(serverUrl);
    const data = await fetchJson<{ Secret?: unknown; Code?: unknown }>(
      `${serverUrl.replace(/\/$/, '')}/QuickConnect/Initiate`,
      {
        method: 'POST',
        headers: {
          Authorization: BaseMediaServerClient.memberClientHeader('MediaBrowser', deviceId),
          Accept: 'application/json',
        },
        service: 'jellyfin',
        timeout: 10_000,
        redirect: 'manual',
      }
    );
    if (typeof data.Secret !== 'string' || typeof data.Code !== 'string') {
      throw new Error('Quick Connect initiate returned no secret');
    }
    return { secret: data.Secret, code: data.Code };
  }

  static async quickConnectStatus(
    serverUrl: string,
    secret: string
  ): Promise<'pending' | 'authenticated' | 'gone'> {
    assertSafeProbeUrl(serverUrl);
    try {
      const data = await fetchJson<{ Authenticated?: unknown }>(
        `${serverUrl.replace(/\/$/, '')}/QuickConnect/Connect?secret=${encodeURIComponent(secret)}`,
        {
          headers: { Accept: 'application/json' },
          service: 'jellyfin',
          timeout: 10_000,
          redirect: 'manual',
        }
      );
      return data.Authenticated === true ? 'authenticated' : 'pending';
    } catch (error) {
      if (isHttpStatus(error, 404)) return 'gone';
      throw error;
    }
  }

  /** The redeemed token belongs to the DeviceId the request was initiated with. */
  static quickConnectRedeem(
    serverUrl: string,
    secret: string,
    deviceId: string
  ): Promise<MediaServerAuth | null> {
    return BaseMediaServerClient.requestUserToken(
      'jellyfin',
      serverUrl,
      '/Users/AuthenticateWithQuickConnect',
      { Authorization: BaseMediaServerClient.memberClientHeader('MediaBrowser', deviceId) },
      { Secret: secret }
    );
  }

  static fetchSelf(
    serverUrl: string,
    token: string
  ): Promise<{ id: string; isDisabled: boolean } | null> {
    return BaseMediaServerClient.requestTokenUser(
      'jellyfin',
      `${serverUrl.replace(/\/$/, '')}/Users/Me`,
      JellyfinClient.memberTokenHeader(token)
    );
  }

  static logoutUserToken(serverUrl: string, token: string): Promise<void> {
    return BaseMediaServerClient.postTokenLogout(
      'jellyfin',
      serverUrl,
      JellyfinClient.memberTokenHeader(token)
    );
  }

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

    const refusal = probeRefusal(url);
    if (refusal) {
      return {
        success: false,
        code: JellyfinClient.AdminVerifyError.CONNECTION_FAILED,
        message: refusal,
      };
    }

    const headers = {
      Authorization: BaseMediaServerClient.buildStaticAuthHeader(apiKey),
      Accept: 'application/json',
    };

    // Verify basic (unauthenticated) connectivity so a network problem is distinct from auth.
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

    // Try /Users/Me first (works for user tokens from AuthenticateByName).
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
        message: 'This Jellyfin account is not an administrator.',
      };
    } catch (error) {
      // 401 means the key was rejected outright. API keys get a 400 here (no user context),
      // which is expected — fall through to /Auth/Keys.
      if (error instanceof HttpClientError && error.statusCode === 401) {
        return {
          success: false,
          code: JellyfinClient.AdminVerifyError.INVALID_KEY,
          message: 'Jellyfin rejected this API key (it may be invalid or expired).',
        };
      }
    }

    // Try /Auth/Keys, which only admin-level API keys can read.
    try {
      await fetchJson<unknown>(`${url}/Auth/Keys`, {
        headers,
        service: 'jellyfin',
        timeout: 10000,
      });
      return { success: true };
    } catch (error) {
      if (error instanceof HttpClientError) {
        if (error.statusCode === 401) {
          return {
            success: false,
            code: JellyfinClient.AdminVerifyError.INVALID_KEY,
            message: 'Jellyfin rejected this API key (it may be invalid or expired).',
          };
        }
        if (error.statusCode === 403) {
          return {
            success: false,
            code: JellyfinClient.AdminVerifyError.NOT_ADMIN,
            message: 'This API key does not have administrator access on this Jellyfin server.',
          };
        }
      }
      const message = error instanceof Error ? error.message : 'Unable to verify admin access';
      return {
        success: false,
        code: JellyfinClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Could not verify admin access on Jellyfin server at ${url}. ${message}`,
      };
    }
  }
}
