import type {
  Server,
  User,
  UserRole,
  ServerUserWithIdentity,
  ServerUserDetail,
  ServerUserFullDetail,
  Session,
  SessionWithDetails,
  ActiveSession,
  Rule,
  Violation,
  ViolationWithDetails,
  DashboardStats,
  PlayStats,
  UserStats,
  TopUserStats,
  LocationStatsResponse,
  UserLocation,
  UserDevice,
  Settings,
  PaginatedResponse,
  MobileConfig,
  TerminationLogWithDetails,
  PlexDiscoveredServer,
  PlexDiscoveredConnection,
  PlexAvailableServersResponse,
  NotificationChannelRouting,
  NotificationEventType,
  HistorySessionResponse,
  HistoryFilterOptions,
  HistoryQueryInput,
  VersionInfo,
} from '@tracearr/shared';

// Re-export shared types needed by frontend components
export type { PlexDiscoveredServer, PlexDiscoveredConnection, PlexAvailableServersResponse };
import { API_BASE_PATH, getClientTimezone } from '@tracearr/shared';

// Stats time range parameters
export interface StatsTimeRange {
  period: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  timezone?: string; // IANA timezone (e.g., 'America/Los_Angeles')
}

// Re-export shared timezone helper for backwards compatibility
// Uses Intl API which works in both browser and React Native
export const getBrowserTimezone = getClientTimezone;

// Types for Plex server selection during signup (from check-pin endpoint)
export interface PlexServerConnection {
  uri: string;
  local: boolean;
  address: string;
  port: number;
}

export interface PlexServerInfo {
  name: string;
  platform: string;
  version: string;
  clientIdentifier: string;
  /**
   * True if Tracearr's public IP matches the server's public IP.
   * When false, local connections have been filtered out as they won't be reachable.
   */
  publicAddressMatches: boolean;
  /**
   * True if the server requires HTTPS connections.
   * When true, HTTP connections have been filtered out as they'll be rejected.
   */
  httpsRequired: boolean;
  connections: PlexServerConnection[];
}

export interface PlexCheckPinResponse {
  authorized: boolean;
  message?: string;
  // If returning user (auto-connect)
  accessToken?: string;
  refreshToken?: string;
  user?: User;
  // If new user (needs server selection)
  needsServerSelection?: boolean;
  servers?: PlexServerInfo[];
  tempToken?: string;
}

// Token storage keys
const ACCESS_TOKEN_KEY = 'tracearr_access_token';
const REFRESH_TOKEN_KEY = 'tracearr_refresh_token';

// Event for auth state changes (logout, token cleared, etc.)
export const AUTH_STATE_CHANGE_EVENT = 'tracearr:auth-state-change';

// Token management utilities
export const tokenStorage = {
  getAccessToken: (): string | null => localStorage.getItem(ACCESS_TOKEN_KEY),
  getRefreshToken: (): string | null => localStorage.getItem(REFRESH_TOKEN_KEY),
  setTokens: (accessToken: string, refreshToken: string) => {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  /**
   * Clear tokens from storage
   * @param silent - If true, don't dispatch auth change event (used for intentional logout)
   */
  clearTokens: (silent = false) => {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    // Dispatch event so auth context can react immediately (unless silent)
    if (!silent) {
      window.dispatchEvent(
        new CustomEvent(AUTH_STATE_CHANGE_EVENT, { detail: { type: 'logout' } })
      );
    }
  },
};

class ApiClient {
  private baseUrl: string;
  private isRefreshing = false;
  private refreshPromise: Promise<boolean> | null = null;

  constructor(baseUrl: string = API_BASE_PATH) {
    this.baseUrl = baseUrl;
  }

  /**
   * Attempt to refresh the access token using the refresh token
   * Returns true if refresh succeeded, false otherwise
   */
  private async refreshAccessToken(): Promise<boolean> {
    const refreshToken = tokenStorage.getRefreshToken();
    if (!refreshToken) {
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        // Only clear tokens on explicit auth rejection (401/403)
        // Don't clear on server errors (500, 502, 503) - server might be restarting
        if (response.status === 401 || response.status === 403) {
          tokenStorage.clearTokens();
        }
        return false;
      }

      const data = await response.json();
      if (data.accessToken && data.refreshToken) {
        tokenStorage.setTokens(data.accessToken, data.refreshToken);
        return true;
      }

      return false;
    } catch {
      // Network error (server down, timeout, etc.)
      // DON'T clear tokens - they might still be valid when server comes back
      return false;
    }
  }

  /**
   * Handle token refresh with deduplication
   * Multiple concurrent 401s will share the same refresh attempt
   */
  private async handleTokenRefresh(): Promise<boolean> {
    if (this.isRefreshing) {
      return this.refreshPromise!;
    }

    this.isRefreshing = true;
    this.refreshPromise = this.refreshAccessToken().finally(() => {
      this.isRefreshing = false;
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async request<T>(path: string, options: RequestInit = {}, isRetry = false): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    // Only set Content-Type for requests with a body
    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }

    // Add Authorization header if we have a token
    const token = tokenStorage.getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      credentials: 'include',
      headers,
    });

    // Handle 401 with automatic token refresh (skip for auth endpoints to avoid loops)
    // Note: /auth/me is NOT in this list - it SHOULD trigger token refresh on 401
    const noRetryPaths = [
      '/auth/login',
      '/auth/signup',
      '/auth/refresh',
      '/auth/logout',
      '/auth/plex/check-pin',
      '/auth/callback',
    ];
    const shouldRetry = !noRetryPaths.some((p) => path.startsWith(p));
    if (response.status === 401 && !isRetry && shouldRetry) {
      const refreshed = await this.handleTokenRefresh();
      if (refreshed) {
        // Retry the original request with new token
        return this.request<T>(path, options, true);
      }
      // Refresh failed - tokens already cleared by refreshAccessToken() if it was a real auth failure
      // Don't clear here - might just be a network error (server restarting)
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message ?? `Request failed: ${response.status}`);
    }

    // Handle empty responses (204 No Content) or responses without JSON
    const contentType = response.headers.get('content-type');
    if (response.status === 204 || !contentType?.includes('application/json')) {
      return undefined as T;
    }

    return response.json();
  }

  // Setup - check if Tracearr needs initial configuration
  setup = {
    status: () =>
      this.request<{
        needsSetup: boolean;
        hasServers: boolean;
        hasJellyfinServers: boolean;
        hasPasswordAuth: boolean;
        primaryAuthMethod: 'jellyfin' | 'local';
      }>('/setup/status'),
  };

  // Auth
  auth = {
    me: () =>
      this.request<{
        userId: string;
        username: string;
        email: string | null;
        thumbnail: string | null;
        role: UserRole;
        aggregateTrustScore: number;
        serverIds: string[];
        hasPassword?: boolean;
        hasPlexLinked?: boolean;
        // Fallback fields for backwards compatibility
        id?: string;
        serverId?: string;
        thumbUrl?: string | null;
        trustScore?: number;
      }>('/auth/me'),
    logout: () => this.request<void>('/auth/logout', { method: 'POST' }),

    // Local account signup (email for login, username for display)
    signup: (data: { email: string; username: string; password: string }) =>
      this.request<{ accessToken: string; refreshToken: string; user: User }>('/auth/signup', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Local account login (uses email)
    loginLocal: (data: { email: string; password: string }) =>
      this.request<{ accessToken: string; refreshToken: string; user: User }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ type: 'local', ...data }),
      }),

    // Plex OAuth - Step 1: Get PIN
    loginPlex: (forwardUrl?: string) =>
      this.request<{ pinId: string; authUrl: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ type: 'plex', forwardUrl }),
      }),

    // Plex OAuth - Step 2: Check PIN and get servers
    checkPlexPin: (pinId: string) =>
      this.request<PlexCheckPinResponse>('/auth/plex/check-pin', {
        method: 'POST',
        body: JSON.stringify({ pinId }),
      }),

    // Jellyfin Admin Login - Authenticate with Jellyfin username/password
    loginJellyfin: (data: { username: string; password: string }) =>
      this.request<{ accessToken: string; refreshToken: string; user: User }>(
        '/auth/jellyfin/login',
        {
          method: 'POST',
          body: JSON.stringify(data),
        }
      ),

    // Plex OAuth - Step 3: Connect with selected server (only for setup)
    connectPlexServer: (data: {
      tempToken: string;
      serverUri: string;
      serverName: string;
      clientIdentifier?: string;
    }) =>
      this.request<{ accessToken: string; refreshToken: string; user: User }>(
        '/auth/plex/connect',
        {
          method: 'POST',
          body: JSON.stringify(data),
        }
      ),

    // Get available Plex servers (authenticated - for adding additional servers)
    getAvailablePlexServers: () =>
      this.request<PlexAvailableServersResponse>('/auth/plex/available-servers'),

    // Add an additional Plex server (authenticated - owner only)
    addPlexServer: (data: { serverUri: string; serverName: string; clientIdentifier: string }) =>
      this.request<{ server: Server; usersAdded: number; librariesSynced: number }>(
        '/auth/plex/add-server',
        {
          method: 'POST',
          body: JSON.stringify(data),
        }
      ),

    // Jellyfin server connection with API key (requires auth)
    connectJellyfinWithApiKey: (data: { serverUrl: string; serverName: string; apiKey: string }) =>
      this.request<{
        accessToken: string;
        refreshToken: string;
        user: User;
      }>('/auth/jellyfin/connect-api-key', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Emby server connection with API key (requires auth)
    connectEmbyWithApiKey: (data: { serverUrl: string; serverName: string; apiKey: string }) =>
      this.request<{
        accessToken: string;
        refreshToken: string;
        user: User;
      }>('/auth/emby/connect-api-key', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Legacy callback (deprecated, kept for compatibility)
    checkPlexCallback: (data: { pinId: string; serverUrl: string; serverName: string }) =>
      this.request<{
        authorized: boolean;
        message?: string;
        accessToken?: string;
        refreshToken?: string;
        user?: User;
      }>('/auth/callback', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  };

  // Servers
  servers = {
    list: async () => {
      const response = await this.request<{ data: Server[] }>('/servers');
      return response.data;
    },
    create: (data: { name: string; type: string; url: string; token: string }) =>
      this.request<Server>('/servers', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => this.request<void>(`/servers/${id}`, { method: 'DELETE' }),
    sync: (id: string) =>
      this.request<{
        success: boolean;
        usersAdded: number;
        usersUpdated: number;
        librariesSynced: number;
        errors: string[];
        syncedAt: string;
      }>(`/servers/${id}/sync`, { method: 'POST', body: JSON.stringify({}) }),
    statistics: (id: string) =>
      this.request<{
        serverId: string;
        data: {
          at: number;
          timespan: number;
          hostCpuUtilization: number;
          processCpuUtilization: number;
          hostMemoryUtilization: number;
          processMemoryUtilization: number;
        }[];
        fetchedAt: string;
      }>(`/servers/${id}/statistics`),
  };

  // Users
  users = {
    list: (params?: { page?: number; pageSize?: number; serverId?: string }) => {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', String(params.page));
      if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
      if (params?.serverId) searchParams.set('serverId', params.serverId);
      return this.request<PaginatedResponse<ServerUserWithIdentity>>(
        `/users?${searchParams.toString()}`
      );
    },
    get: (id: string) => this.request<ServerUserDetail>(`/users/${id}`),
    getFull: (id: string) => this.request<ServerUserFullDetail>(`/users/${id}/full`),
    update: (id: string, data: { trustScore?: number }) =>
      this.request<ServerUserWithIdentity>(`/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    updateIdentity: (id: string, data: { name: string | null }) =>
      this.request<{ success: boolean; name: string | null }>(`/users/${id}/identity`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    sessions: (id: string, params?: { page?: number; pageSize?: number }) => {
      const query = new URLSearchParams(params as Record<string, string>).toString();
      return this.request<PaginatedResponse<Session>>(`/users/${id}/sessions?${query}`);
    },
    locations: async (id: string) => {
      const response = await this.request<{ data: UserLocation[] }>(`/users/${id}/locations`);
      return response.data;
    },
    devices: async (id: string) => {
      const response = await this.request<{ data: UserDevice[] }>(`/users/${id}/devices`);
      return response.data;
    },
    terminations: (id: string, params?: { page?: number; pageSize?: number }) => {
      const query = new URLSearchParams(params as Record<string, string>).toString();
      return this.request<PaginatedResponse<TerminationLogWithDetails>>(
        `/users/${id}/terminations?${query}`
      );
    },
  };

  // Sessions
  sessions = {
    list: (params?: { page?: number; pageSize?: number; userId?: string; serverId?: string }) => {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', String(params.page));
      if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
      if (params?.userId) searchParams.set('userId', params.userId);
      if (params?.serverId) searchParams.set('serverId', params.serverId);
      return this.request<PaginatedResponse<SessionWithDetails>>(
        `/sessions?${searchParams.toString()}`
      );
    },
    /**
     * Query history with cursor-based pagination and advanced filters.
     * Supports infinite scroll patterns with aggregate stats.
     */
    history: (params: Partial<HistoryQueryInput> & { cursor?: string }) => {
      const searchParams = new URLSearchParams();
      if (params.cursor) searchParams.set('cursor', params.cursor);
      if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
      if (params.serverUserId) searchParams.set('serverUserId', params.serverUserId);
      if (params.serverId) searchParams.set('serverId', params.serverId);
      if (params.state) searchParams.set('state', params.state);
      if (params.mediaType) searchParams.set('mediaType', params.mediaType);
      if (params.startDate) searchParams.set('startDate', params.startDate.toISOString());
      if (params.endDate) searchParams.set('endDate', params.endDate.toISOString());
      if (params.search) searchParams.set('search', params.search);
      if (params.platform) searchParams.set('platform', params.platform);
      if (params.product) searchParams.set('product', params.product);
      if (params.device) searchParams.set('device', params.device);
      if (params.playerName) searchParams.set('playerName', params.playerName);
      if (params.ipAddress) searchParams.set('ipAddress', params.ipAddress);
      if (params.geoCountry) searchParams.set('geoCountry', params.geoCountry);
      if (params.geoCity) searchParams.set('geoCity', params.geoCity);
      if (params.geoRegion) searchParams.set('geoRegion', params.geoRegion);
      if (params.isTranscode !== undefined)
        searchParams.set('isTranscode', String(params.isTranscode));
      if (params.watched !== undefined) searchParams.set('watched', String(params.watched));
      if (params.excludeShortSessions) searchParams.set('excludeShortSessions', 'true');
      if (params.orderBy) searchParams.set('orderBy', params.orderBy);
      if (params.orderDir) searchParams.set('orderDir', params.orderDir);
      return this.request<HistorySessionResponse>(`/sessions/history?${searchParams.toString()}`);
    },
    /**
     * Get available filter values for dropdowns on the History page.
     */
    filterOptions: (serverId?: string) => {
      const searchParams = new URLSearchParams();
      if (serverId) searchParams.set('serverId', serverId);
      return this.request<HistoryFilterOptions>(
        `/sessions/filter-options?${searchParams.toString()}`
      );
    },
    getActive: async (serverId?: string) => {
      const params = new URLSearchParams();
      if (serverId) params.set('serverId', serverId);
      const query = params.toString();
      const response = await this.request<{ data: ActiveSession[] }>(
        `/sessions/active${query ? `?${query}` : ''}`
      );
      return response.data;
    },
    get: (id: string) => this.request<Session>(`/sessions/${id}`),
    terminate: (id: string, reason?: string) =>
      this.request<{ success: boolean; terminationLogId: string; message: string }>(
        `/sessions/${id}/terminate`,
        { method: 'POST', body: JSON.stringify({ reason }) }
      ),
  };

  // Rules
  rules = {
    list: async () => {
      const response = await this.request<{ data: Rule[] }>('/rules');
      return response.data;
    },
    create: (data: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>) =>
      this.request<Rule>('/rules', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Rule>) =>
      this.request<Rule>(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => this.request<void>(`/rules/${id}`, { method: 'DELETE' }),
  };

  // Violations
  violations = {
    list: (params?: {
      page?: number;
      pageSize?: number;
      userId?: string;
      severity?: string;
      acknowledged?: boolean;
      serverId?: string;
    }) => {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', String(params.page));
      if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
      if (params?.userId) searchParams.set('userId', params.userId);
      if (params?.severity) searchParams.set('severity', params.severity);
      if (params?.acknowledged !== undefined)
        searchParams.set('acknowledged', String(params.acknowledged));
      if (params?.serverId) searchParams.set('serverId', params.serverId);
      return this.request<PaginatedResponse<ViolationWithDetails>>(
        `/violations?${searchParams.toString()}`
      );
    },
    acknowledge: (id: string) => this.request<Violation>(`/violations/${id}`, { method: 'PATCH' }),
    dismiss: (id: string) => this.request<void>(`/violations/${id}`, { method: 'DELETE' }),
  };

  // Stats - helper to build stats query params
  private buildStatsParams(timeRange?: StatsTimeRange, serverId?: string): URLSearchParams {
    const params = new URLSearchParams();
    if (timeRange?.period) params.set('period', timeRange.period);
    if (timeRange?.startDate) params.set('startDate', timeRange.startDate);
    if (timeRange?.endDate) params.set('endDate', timeRange.endDate);
    if (serverId) params.set('serverId', serverId);
    // Always include timezone for consistent chart display
    // Use provided timezone or fall back to browser's timezone
    params.set('timezone', timeRange?.timezone ?? getBrowserTimezone());
    return params;
  }

  stats = {
    dashboard: (serverId?: string) => {
      const params = new URLSearchParams();
      if (serverId) params.set('serverId', serverId);
      // Include timezone so "today" is calculated in user's local timezone
      params.set('timezone', getBrowserTimezone());
      return this.request<DashboardStats>(`/stats/dashboard?${params.toString()}`);
    },
    plays: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'week' }, serverId);
      const response = await this.request<{ data: PlayStats[] }>(
        `/stats/plays?${params.toString()}`
      );
      return response.data;
    },
    users: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      const response = await this.request<{ data: UserStats[] }>(
        `/stats/users?${params.toString()}`
      );
      return response.data;
    },
    locations: async (params?: {
      timeRange?: StatsTimeRange;
      serverUserId?: string;
      serverId?: string;
      mediaType?: 'movie' | 'episode' | 'track';
    }) => {
      const searchParams = new URLSearchParams();
      if (params?.timeRange?.period) searchParams.set('period', params.timeRange.period);
      if (params?.timeRange?.startDate) searchParams.set('startDate', params.timeRange.startDate);
      if (params?.timeRange?.endDate) searchParams.set('endDate', params.timeRange.endDate);
      if (params?.serverUserId) searchParams.set('serverUserId', params.serverUserId);
      if (params?.serverId) searchParams.set('serverId', params.serverId);
      if (params?.mediaType) searchParams.set('mediaType', params.mediaType);
      const query = searchParams.toString();
      return this.request<LocationStatsResponse>(`/stats/locations${query ? `?${query}` : ''}`);
    },
    playsByDayOfWeek: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      const response = await this.request<{ data: { day: number; name: string; count: number }[] }>(
        `/stats/plays-by-dayofweek?${params.toString()}`
      );
      return response.data;
    },
    playsByHourOfDay: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      const response = await this.request<{ data: { hour: number; count: number }[] }>(
        `/stats/plays-by-hourofday?${params.toString()}`
      );
      return response.data;
    },
    platforms: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      const response = await this.request<{ data: { platform: string | null; count: number }[] }>(
        `/stats/platforms?${params.toString()}`
      );
      return response.data;
    },
    quality: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      return this.request<{
        directPlay: number;
        transcode: number;
        total: number;
        directPlayPercent: number;
        transcodePercent: number;
      }>(`/stats/quality?${params.toString()}`);
    },
    topUsers: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      const response = await this.request<{ data: TopUserStats[] }>(
        `/stats/top-users?${params.toString()}`
      );
      return response.data;
    },
    topContent: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      const response = await this.request<{
        movies: {
          title: string;
          type: 'movie';
          year: number | null;
          playCount: number;
          watchTimeHours: number;
          thumbPath: string | null;
          serverId: string | null;
          ratingKey: string | null;
        }[];
        shows: {
          title: string;
          type: 'episode';
          year: number | null;
          playCount: number;
          episodeCount: number;
          watchTimeHours: number;
          thumbPath: string | null;
          serverId: string | null;
          ratingKey: string | null;
        }[];
      }>(`/stats/top-content?${params.toString()}`);
      return response;
    },
    concurrent: async (timeRange?: StatsTimeRange, serverId?: string) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      const response = await this.request<{
        data: { hour: string; total: number; direct: number; transcode: number }[];
      }>(`/stats/concurrent?${params.toString()}`);
      return response.data;
    },
  };

  // Settings
  settings = {
    get: () => this.request<Settings>('/settings'),
    update: (data: Partial<Settings>) =>
      this.request<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),
    testWebhook: (data: {
      type: 'discord' | 'custom';
      url?: string;
      format?: 'json' | 'ntfy' | 'apprise';
      ntfyTopic?: string;
      ntfyAuthToken?: string;
    }) =>
      this.request<{ success: boolean; error?: string }>('/settings/test-webhook', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  };

  // Channel Routing
  channelRouting = {
    getAll: () => this.request<NotificationChannelRouting[]>('/settings/notifications/routing'),
    update: (
      eventType: NotificationEventType,
      data: { discordEnabled?: boolean; webhookEnabled?: boolean }
    ) =>
      this.request<NotificationChannelRouting>(`/settings/notifications/routing/${eventType}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  };

  // Import
  import = {
    tautulli: {
      test: (url: string, apiKey: string) =>
        this.request<{
          success: boolean;
          message: string;
          users?: number;
          historyRecords?: number;
        }>('/import/tautulli/test', { method: 'POST', body: JSON.stringify({ url, apiKey }) }),
      start: (serverId: string) =>
        this.request<{ status: string; jobId?: string; message: string }>('/import/tautulli', {
          method: 'POST',
          body: JSON.stringify({ serverId }),
        }),
      getActive: (serverId: string) =>
        this.request<{
          active: boolean;
          jobId?: string;
          state?: string;
          progress?: number | object;
          createdAt?: number;
        }>(`/import/tautulli/active/${serverId}`),
      getStatus: (jobId: string) =>
        this.request<{
          jobId: string;
          state: string;
          progress: number | object | null;
          result?: {
            success: boolean;
            imported: number;
            skipped: number;
            errors: number;
            message: string;
          };
          failedReason?: string;
          createdAt?: number;
          finishedAt?: number;
        }>(`/import/tautulli/${jobId}`),
    },
  };

  // Mobile access
  mobile = {
    get: () => this.request<MobileConfig>('/mobile'),
    enable: () => this.request<MobileConfig>('/mobile/enable', { method: 'POST', body: '{}' }),
    disable: () =>
      this.request<{ success: boolean }>('/mobile/disable', { method: 'POST', body: '{}' }),
    generatePairToken: () =>
      this.request<{ token: string; expiresAt: string }>('/mobile/pair-token', {
        method: 'POST',
        body: '{}',
      }),
    revokeSession: (id: string) =>
      this.request<{ success: boolean }>(`/mobile/sessions/${id}`, { method: 'DELETE' }),
    revokeSessions: () =>
      this.request<{ success: boolean; revokedCount: number }>('/mobile/sessions', {
        method: 'DELETE',
      }),
  };

  // Version info
  version = {
    get: () => this.request<VersionInfo>('/version'),
    check: () =>
      this.request<{ message: string }>('/version/check', { method: 'POST', body: '{}' }),
  };
}

export const api = new ApiClient();
