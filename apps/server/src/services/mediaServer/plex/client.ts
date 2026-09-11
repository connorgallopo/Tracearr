/**
 * Plex Media Server Client
 *
 * Implements IMediaServerClient for Plex servers.
 * Provides a unified interface for session tracking, user management, and library access.
 */

import { fetchJson, fetchText, plexHeaders, getPlexClientIdentifier } from '../../../utils/http.js';
import { assertSafeProbeUrl, SsrfBlockedError } from '../../../utils/ssrf.js';
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
  parseStatisticsBandwidthResponse,
  parseMediaMetadataResponse,
  parseLibraryItemsResponse,
  parseGenresByRatingKey,
  getTranscodingSessionRatingKeys,
  type PlexServerResource,
  type PlexStatisticsDataPoint,
  type PlexBandwidthStats,
  type PlexOriginalMedia,
} from './parser.js';

const PLEX_TV_BASE = 'https://plex.tv';

/** ratingKeys per /library/metadata request when filling in genres. */
const GENRE_BATCH_SIZE = 100;

/**
 * Drops the per-item elements a genre lookup doesn't read; on a real server
 * this cut a 40-movie batch from about 780 KB to 71 KB.
 */
const GENRE_LOOKUP_PARAMS = new URLSearchParams({
  excludeElements:
    'Media,Role,Director,Writer,Producer,Country,Guid,Rating,Image,UltraBlurColors,Location,Similar,Field',
  excludeFields: 'summary,tagline',
});

/**
 * Plex Media Server client implementation
 *
 * @example
 * const client = new PlexClient({ url: 'http://plex.local:32400', token: 'xxx' });
 * const sessions = await client.getSessions();
 */
export class PlexClient implements IMediaServerClient, IMediaServerClientWithHistory {
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

    const transcodingEntries = getTranscodingSessionRatingKeys(data);

    let originalMediaMap: Map<string, PlexOriginalMedia> | undefined;
    if (transcodingEntries.length > 0) {
      // Deduplicate ratingKeys — multiple sessions may play different versions of the same item
      const uniqueRatingKeys = [...new Set(transcodingEntries.map((e) => e.ratingKey))];
      const metadataResults = await Promise.allSettled(
        uniqueRatingKeys.map((ratingKey) => this.getMediaMetadata(ratingKey))
      );

      const rawMetadataByRatingKey = new Map<string, unknown>();
      metadataResults.forEach((result, index) => {
        const ratingKey = uniqueRatingKeys[index];
        if (result.status === 'fulfilled' && result.value && ratingKey) {
          rawMetadataByRatingKey.set(ratingKey, result.value);
        }
      });

      originalMediaMap = new Map();
      for (const { ratingKey, sessionMediaId } of transcodingEntries) {
        const rawData = rawMetadataByRatingKey.get(ratingKey);
        if (!rawData) continue;

        const parsed = parseMediaMetadataResponse(rawData, sessionMediaId);
        if (!parsed) continue;

        if (sessionMediaId) {
          originalMediaMap.set(`${ratingKey}:${sessionMediaId}`, parsed);
        } else {
          originalMediaMap.set(ratingKey, parsed);
        }
      }
    }

    return parseSessionsResponse(data, originalMediaMap);
  }

  /**
   * Get raw media metadata for a specific item.
   *
   * Returns the raw response so the caller can parse it with different targetMediaId
   * values per session (e.g., when multiple sessions play different versions of the same item).
   *
   * @param ratingKey - The media item's ratingKey
   */
  async getMediaMetadata(ratingKey: string): Promise<unknown> {
    try {
      return await fetchJson<unknown>(`${this.baseUrl}/library/metadata/${ratingKey}`, {
        headers: this.buildHeaders(),
        service: 'plex',
        timeout: 5000, // Short timeout since this is supplementary data
      });
    } catch {
      return null;
    }
  }

  /**
   * The server's machineIdentifier, needed to address it on app.plex.tv.
   */
  async getServerIdentity(): Promise<string | null> {
    const data = await fetchJson<{ MediaContainer?: { machineIdentifier?: unknown } }>(
      `${this.baseUrl}/identity`,
      { headers: this.buildHeaders(), service: 'plex', timeout: 10000 }
    );
    const id = data.MediaContainer?.machineIdentifier;
    return typeof id === 'string' && id ? id : null;
  }

  /** The version Plex reports for itself, build hash and all. */
  async getSoftwareVersion(): Promise<string | null> {
    const data = await fetchJson<{ MediaContainer?: { version?: unknown } }>(
      `${this.baseUrl}/identity`,
      { headers: this.buildHeaders(), service: 'plex', timeout: 10000 }
    );
    const version = data.MediaContainer?.version;
    return typeof version === 'string' && version ? version : null;
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

    const items = await this.fillTruncatedGenres(parseLibraryItemsResponse(data));

    return { items, totalCount };
  }

  /**
   * Get library items updated since the given date.
   * Sorts by updatedAt:desc and paginates until items fall below the cutoff.
   */
  async getLibraryItemsSince(
    libraryId: string,
    since: Date,
    _options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const sinceUnix = Math.floor(since.getTime() / 1000);
    const result = await this.fetchItemsSortedByUpdatedAt(
      `/library/sections/${libraryId}/all`,
      sinceUnix
    );
    return { ...result, items: await this.fillTruncatedGenres(result.items) };
  }

  /**
   * Plex list endpoints return at most two Genre tags per item, whatever the
   * item carries. /library/metadata has the full list and takes a
   * comma-separated batch of ratingKeys, so only items that hit the cap are
   * looked up again.
   */
  private async fillTruncatedGenres(items: MediaLibraryItem[]): Promise<MediaLibraryItem[]> {
    const capped = items.filter((item) => (item.genres?.length ?? 0) >= 2);
    const fullGenres = new Map<string, string[]>();

    for (let start = 0; start < capped.length; start += GENRE_BATCH_SIZE) {
      const ratingKeys = capped
        .slice(start, start + GENRE_BATCH_SIZE)
        .map((item) => item.ratingKey);
      const data = await fetchJson<unknown>(
        `${this.baseUrl}/library/metadata/${ratingKeys.join(',')}?${GENRE_LOOKUP_PARAMS}`,
        { headers: this.buildHeaders(), service: 'plex', timeout: 30000 }
      );
      for (const [ratingKey, genres] of parseGenresByRatingKey(data)) {
        fullGenres.set(ratingKey, genres);
      }
    }

    return items.map((item) => {
      const genres = fullGenres.get(item.ratingKey);
      return genres ? { ...item, genres } : item;
    });
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

  /** Get leaf items (episodes/tracks) updated since the given date. */
  async getLibraryLeavesSince(
    libraryId: string,
    since: Date,
    _options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const sinceUnix = Math.floor(since.getTime() / 1000);
    return this.fetchItemsSortedByUpdatedAt(`/library/sections/${libraryId}/allLeaves`, sinceUnix);
  }

  /**
   * Get all seasons in a TV library section (type=3), with pagination.
   * Separate from getLibraryItems/getLibraryLeaves since Plex has no combined
   * shows+seasons+episodes endpoint. Paginates via headers - see
   * fetchItemsSortedByUpdatedAt's doc for why type-filtered requests need that.
   */
  async getLibrarySeasons(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount?: number }> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;

    const params = new URLSearchParams({ type: '3', includeGuids: '1' });

    const data = await fetchJson<unknown>(
      `${this.baseUrl}/library/sections/${libraryId}/all?${params}`,
      {
        headers: {
          ...this.buildHeaders(),
          'X-Plex-Container-Start': String(offset),
          'X-Plex-Container-Size': String(limit),
        },
        service: 'plex',
        timeout: 30000,
      }
    );

    const container = data as { MediaContainer?: { totalSize?: number } };
    const totalCount = container?.MediaContainer?.totalSize ?? 0;
    const items = parseLibraryItemsResponse(data);

    return { items, totalCount };
  }

  /** Get seasons updated since the given date. */
  async getLibrarySeasonsSince(
    libraryId: string,
    since: Date,
    _options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const sinceUnix = Math.floor(since.getTime() / 1000);
    return this.fetchItemsSortedByUpdatedAt(`/library/sections/${libraryId}/all`, sinceUnix, {
      extraParams: { type: '3' },
      paginateViaHeaders: true,
    });
  }

  /**
   * Fetch items sorted by updatedAt:desc, collecting items until one falls
   * below sinceUnix. Replaces the broken addedAt>>= filter which is silently
   * ignored on Plex 1.43.x+.
   *
   * @param extraParams - Extra query params merged in (e.g. type=3 for seasons)
   * @param paginateViaHeaders - Plex ignores X-Plex-Container-Start/Size as query
   *   params on type-filtered requests (always returns the full result set) but
   *   honors them as HTTP headers; set true for any type=N request.
   */
  private async fetchItemsSortedByUpdatedAt(
    path: string,
    sinceUnix: number,
    options?: { extraParams?: Record<string, string>; paginateViaHeaders?: boolean }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 500;
    const paginateViaHeaders = options?.paginateViaHeaders ?? false;
    const allItems: MediaLibraryItem[] = [];
    let offset = 0;
    let pageCount = 0;

    while (true) {
      if (++pageCount > MAX_PAGES) {
        console.warn(
          `[PlexClient] Sort-based fetch hit ${MAX_PAGES} page limit on ${path}, returning partial results`
        );
        break;
      }
      const paramsObj: Record<string, string> = {
        includeGuids: '1',
        sort: 'updatedAt:desc',
        ...options?.extraParams,
      };
      if (!paginateViaHeaders) {
        paramsObj['X-Plex-Container-Start'] = String(offset);
        paramsObj['X-Plex-Container-Size'] = String(PAGE_SIZE);
      }
      const params = new URLSearchParams(paramsObj);

      const data = await fetchJson<unknown>(`${this.baseUrl}${path}?${params}`, {
        headers: {
          ...this.buildHeaders(),
          ...(paginateViaHeaders
            ? {
                'X-Plex-Container-Start': String(offset),
                'X-Plex-Container-Size': String(PAGE_SIZE),
              }
            : {}),
        },
        service: 'plex',
        timeout: 30000,
      });

      const items = parseLibraryItemsResponse(data);
      if (items.length === 0) break;

      let hitCutoff = false;
      for (const item of items) {
        const itemUpdatedAt = item.updatedAt ? Math.floor(item.updatedAt.getTime() / 1000) : 0;

        if (itemUpdatedAt >= sinceUnix) {
          allItems.push(item);
        } else {
          hitCutoff = true;
          break;
        }
      }

      if (hitCutoff) break;
      offset += items.length;
    }

    return { items: allItems, totalCount: allItems.length };
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
      // Bounds the call so an unresponsive PMS can't wedge the kill worker.
      signal: AbortSignal.timeout(10000),
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

    try {
      const data = await fetchJson<unknown>(url, {
        headers: this.buildHeaders(),
        service: 'plex',
        timeout: 10000,
      });

      return parseStatisticsResourcesResponse(data);
    } catch {
      // Requires Plex Pass — silently return empty when unavailable
      return [];
    }
  }

  /**
   * Get server bandwidth statistics (Local/Remote traffic)
   *
   * Uses the undocumented /statistics/bandwidth endpoint.
   * Returns aggregated per-second points plus per-account/device samples.
   *
   * @param timespan - Plex API timespan parameter (default: 6)
   * @returns Bandwidth stats, series sorted newest first
   */
  async getServerBandwidth(timespan: number = 6): Promise<PlexBandwidthStats> {
    const url = `${this.baseUrl}/statistics/bandwidth?timespan=${timespan}`;

    try {
      const data = await fetchJson<unknown>(url, {
        headers: this.buildHeaders(),
        service: 'plex',
        timeout: 10000,
      });

      return parseStatisticsBandwidthResponse(data);
    } catch {
      // Requires Plex Pass — silently return empty when unavailable
      return { points: [], samples: [], accounts: [], devices: [] };
    }
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

    // Must match the identifier the PIN was created under above, or plex.tv
    // binds the authorisation to a different device and polling never resolves.
    const params = new URLSearchParams({
      clientID: getPlexClientIdentifier(),
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
   *
   * Also detects Plex's 2025 "strong" PIN variant, which returns a
   * server-refreshable JWT instead of a long-lived legacy token. The exact
   * response shape for that variant was not confirmed against Plex's
   * authentication docs at implementation time (see forums.plex.tv
   * "Authenticating with Plex", thread 609370), so `parseStrongJwtPin` is a
   * conservative capability check: initiateOAuth does not request the
   * JWK-based strong flow, so real responses never match this shape and
   * this always falls back to the legacy `authToken` path below.
   */
  static async checkOAuthPin(pinId: string): Promise<{
    id: string;
    username: string;
    email: string;
    thumb: string;
    token: string;
    tokenKind: 'jwt' | 'legacy';
    refreshToken: string | null;
    expiresAt: Date | null;
  } | null> {
    const headers = plexHeaders();

    const pin = await fetchJson<StrongPinResponse>(`${PLEX_TV_BASE}/api/v2/pins/${pinId}`, {
      headers,
      service: 'plex.tv',
    });

    const strong = parseStrongJwtPin(pin);
    const token = strong?.accessToken ?? pin.authToken;

    if (!token) {
      return null;
    }

    // Fetch user info with the token
    const user = await fetchJson<Record<string, unknown>>(`${PLEX_TV_BASE}/api/v2/user`, {
      headers: plexHeaders(token),
      service: 'plex.tv',
    });

    return {
      id: String(user.id ?? ''),
      username: String(user.username ?? ''),
      email: String(user.email ?? ''),
      thumb: String(user.thumb ?? ''),
      token,
      tokenKind: strong ? 'jwt' : 'legacy',
      refreshToken: strong?.refreshToken ?? null,
      expiresAt: strong?.expiresAt ?? null,
    };
  }

  /**
   * Refresh a strong-PIN JWT access token server-side.
   *
   * Speculative like `parseStrongJwtPin` above: the refresh request/response
   * shape is unconfirmed, so any unexpected response degrades to `null`
   * rather than throwing. Callers must leave the existing token in place on
   * a `null` result - refresh failures never lock a user out.
   */
  static async refreshStrongToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  } | null> {
    try {
      const data = await fetchJson<StrongJwtPayload>('https://clients.plex.tv/api/v2/auth/token', {
        method: 'POST',
        headers: {
          ...plexHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ refresh_token: refreshToken }),
        service: 'plex.tv',
      });

      // Some refresh flows don't rotate the refresh token on every call -
      // fall back to the one we sent if the response doesn't include a new one.
      const strong = parseStrongJwtPin({
        ...data,
        refreshToken: data.refreshToken ?? refreshToken,
      });
      if (!strong) {
        return null;
      }

      return {
        accessToken: strong.accessToken,
        refreshToken: strong.refreshToken,
        expiresAt: strong.expiresAt,
      };
    } catch {
      return null;
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

    try {
      assertSafeProbeUrl(url);
    } catch (err) {
      const message = err instanceof SsrfBlockedError ? err.message : 'URL not permitted';
      return {
        success: false,
        code: PlexClient.AdminVerifyError.CONNECTION_FAILED,
        message,
      };
    }

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

    // Enrich friends with shared_libraries from shared_servers
    // Only include users who have access to THIS server
    const usersWithAccess = allFriends
      .filter((friend) => sharedServerMap.has(friend.id))
      .map((friend) => ({
        ...friend,
        sharedLibraries: sharedServerMap.get(friend.id)?.sharedLibraries ?? [],
      }));

    // Owner always has access to all libraries
    return [owner, ...usersWithAccess];
  }
}

/** Shape of a GET /api/v2/pins/:id response, legacy fields plus speculative strong-JWT fields */
interface StrongPinResponse extends StrongJwtPayload {
  authToken: string | null;
}

/** Speculative strong-PIN JWT fields; unconfirmed against Plex's docs (see checkOAuthPin) */
interface StrongJwtPayload {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

/**
 * Capability check for the strong-PIN JWT variant. Returns null (legacy
 * fallback) unless all three JWT fields are present and well-formed - a
 * partial or malformed payload is treated the same as "not the JWT variant".
 */
function parseStrongJwtPin(
  payload: StrongJwtPayload
): { accessToken: string; refreshToken: string; expiresAt: Date } | null {
  const { accessToken, refreshToken, expiresIn } = payload;

  if (
    typeof accessToken !== 'string' ||
    !accessToken ||
    typeof refreshToken !== 'string' ||
    !refreshToken ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}
