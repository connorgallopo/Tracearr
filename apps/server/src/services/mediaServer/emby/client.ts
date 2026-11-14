/**
 * Emby Media Server Client
 *
 * Implements IMediaServerClient for Emby servers.
 * Extends BaseMediaServerClient with Emby-specific authentication and activity log handling.
 *
 * Based on Emby OpenAPI specification v4.1.1.0
 */

import { REDIS_KEYS } from '@tracearr/shared';
import { getRedis } from '../../../lib/redisShared.js';
import { fetchJson, HttpClientError } from '../../../utils/http.js';
import { probeRefusal } from '../../../utils/ssrf.js';
import type { MediaServerAuth, MediaServerConfig } from '../types.js';
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
  parseSyncJobItems,
  parseSyncJobs,
  parseUser,
} from './parser.js';
import type { EmbySyncJob, EmbySyncJobItem } from '../shared/jellyfinEmbyParser.js';

const USER_GUID_TTL_SECONDS = 24 * 60 * 60;

// Re-export types with platform-specific aliases for backward compatibility
export type EmbyActivityEntry = JellyfinEmbyActivityEntry;
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
  };

  private readonly cacheScope: string;

  constructor(config: MediaServerConfig) {
    super(config);
    this.cacheScope = config.id ?? this.baseUrl;
  }

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

  // App downloads write no activity entry; they exist only as sync jobs
  override async getSyncJobs(): Promise<EmbySyncJob[]> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/Sync/Jobs`, {
      headers: this.buildHeaders(),
      service: 'emby',
      timeout: 10000,
    });
    return parseSyncJobs(data);
  }

  override async getSyncJobItems(): Promise<EmbySyncJobItem[]> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/Sync/JobItems`, {
      headers: this.buildHeaders(),
      service: 'emby',
      timeout: 10000,
    });
    return parseSyncJobItems(data);
  }

  /**
   * The activity log names users by Emby's numeric internal id; serverUsers holds the GUID.
   * A deleted user answers 404 and resolves to null; both outcomes are cached.
   */
  override async resolveUserGuid(numericId: string): Promise<string | null> {
    const redis = getRedis();
    const key = REDIS_KEYS.EMBY_USER_GUID(this.cacheScope, numericId);
    const cached = await redis.get(key);
    if (cached !== null) return cached || null;

    let guid = '';
    try {
      const user = await fetchJson<{ Id?: unknown }>(
        `${this.baseUrl}/Users/${encodeURIComponent(numericId)}`,
        { headers: this.buildHeaders(), service: 'emby' }
      );
      if (typeof user.Id === 'string') guid = user.Id;
    } catch (error) {
      if (!(error instanceof HttpClientError && error.statusCode === 404)) throw error;
    }
    await redis.set(key, guid, 'EX', USER_GUID_TTL_SECONDS);
    return guid || null;
  }

  // ==========================================================================
  // Static Methods - Authentication (Emby-specific)
  // ==========================================================================

  // Emby takes the client identity in X-Emby-Authorization, and on 4.10 the password as Pw,
  // the same field name Jellyfin uses.
  static authenticateByName(
    serverUrl: string,
    username: string,
    pw: string,
    deviceId: string,
    forwardedFor: string
  ): Promise<MediaServerAuth | null> {
    return BaseMediaServerClient.requestUserToken(
      'emby',
      serverUrl,
      '/Users/AuthenticateByName',
      {
        'X-Emby-Authorization': BaseMediaServerClient.memberClientHeader('Emby', deviceId),
        ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
      },
      { Username: username, Pw: pw }
    );
  }

  // Emby 4.10 has no /Users/Me, so the token is checked against the user it was issued to.
  static fetchSelf(
    serverUrl: string,
    token: string,
    externalId: string
  ): Promise<{ id: string; isDisabled: boolean } | null> {
    return BaseMediaServerClient.requestTokenUser(
      'emby',
      `${serverUrl.replace(/\/$/, '')}/Users/${encodeURIComponent(externalId)}`,
      { 'X-Emby-Token': token }
    );
  }

  static logoutUserToken(serverUrl: string, token: string): Promise<void> {
    return BaseMediaServerClient.postTokenLogout('emby', serverUrl, { 'X-Emby-Token': token });
  }

  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  /**
   * Verify that a token has admin access to an Emby server.
   *
   * API keys get a 500 at /Users/Me on Emby 4.9 and are verified via
   * /Auth/Keys, which only admin keys can read.
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
        code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
        message: refusal,
      };
    }

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
