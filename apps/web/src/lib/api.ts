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
  Automation,
  AutomationKind,
  AutomationListQuery,
  AutomationRun,
  AutomationRunSummary,
  AutomationSortField,
  CreateAutomationInput,
  DryRunRequest,
  DryRunResponse,
  NearMissEntry,
  RunCounts,
  RunListQuery,
  RunSortField,
  UpdateAutomationInput,
  ViolationWithDetails,
  ViolationRosterFilters,
  ViolationSortField,
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
  PlexAccount,
  PlexAccountsResponse,
  LinkPlexAccountResponse,
  UnlinkPlexAccountResponse,
  ReauthorizePlexAccountResponse,
  Destination,
  DestinationKind,
  CreateDestinationInput,
  UpdateDestinationInput,
  HistorySessionResponse,
  HistoryFilterOptions,
  AutomationFilterOptions,
  HistoryQueryInput,
  HistoryAggregatesQueryInput,
  HistoryAggregates,
  VersionInfo,
  EngagementStats,
  ShowStatsResponse,
  SetupStatus,
  MediaType,
  ServerConnectionStatus,
  // New analytics types
  DeviceCompatibilityResponse,
  DeviceCompatibilityMatrix,
  DeviceHealthResponse,
  TranscodeHotspotsResponse,
  TopTranscodingUsersResponse,
  DailyBandwidthResponse,
  BandwidthTopUsersResponse,
  BandwidthSummary,
  // Library statistics types
  LibraryStatsResponse,
  LibraryGrowthResponse,
  LibraryQualityResponse,
  LibraryStorageResponse,
  DuplicatesResponse,
  StaleResponse,
  WatchResponse,
  CompletionResponse,
  PatternsResponse,
  RoiResponse,
  TopMoviesResponse,
  TopShowsResponse,
  LibraryCodecsResponse,
  LibraryResolutionResponse,
  RunningTasksResponse,
  TailscaleInfo,
  // Backup & Restore types
  BackupMetadata,
  BackupListItem,
  BackupScheduleType,
  // Cross-server user merging types
  UserMergeResult,
  MergeSuggestion,
  ServerUserSplitResult,
  UserSortField,
  UserRosterFilters,
  ListResponse,
  // Media browsing types
  WatchedState,
  CatalogResponse,
  CatalogLettersResponse,
  ShelvesResponse,
  GenresResponse,
  LibrariesResponse,
  MediaDetailResponse,
  MediaChildrenResponse,
  MediaStatsResponse,
  MediaWatchersResponse,
  MediaPlatformBreakdownResponse,
  MediaSeasonHeatResponse,
  ImageCacheStatus,
  ServerResourceDataPoint,
  ServerBandwidthDataPoint,
  BandwidthSample,
  BandwidthAccount,
  BandwidthDevice,
  TEMPLATE_GROUPS,
  TemplateDefinition,
  TemplateEnvelope,
  TemplateInput,
} from '@tracearr/shared';

// Re-export shared types needed by frontend components
export type {
  PlexDiscoveredServer,
  PlexDiscoveredConnection,
  PlexAvailableServersResponse,
  PlexAccount,
  PlexAccountsResponse,
};
import { API_BASE_PATH, getClientTimezone } from '@tracearr/shared';

import { BASE_PATH } from '@/lib/basePath';
export { BASE_PATH, BASE_URL, imageProxyUrl } from '@/lib/basePath';
import { MAINTENANCE_EVENT } from '@/hooks/useMaintenanceMode';

/** Roster query params: the server's own filter schema plus paging and sort. */
export type UserListParams = Partial<UserRosterFilters> & {
  page?: number;
  pageSize?: number;
  orderBy?: UserSortField;
  orderDir?: 'asc' | 'desc';
};

/** Violation query params: the server's own filter schema plus paging and sort. */
export type ViolationListParams = Partial<ViolationRosterFilters> & {
  page?: number;
  pageSize?: number;
  orderBy?: ViolationSortField;
  orderDir?: 'asc' | 'desc';
};

/** Automation query params: the server's own filter schema plus paging and sort. */
export type AutomationListParams = Partial<
  Pick<
    AutomationListQuery,
    'kind' | 'enabled' | 'search' | 'source' | 'serverId' | 'trigger' | 'severity'
  >
> & {
  page?: number;
  pageSize?: number;
  orderBy?: AutomationSortField;
  orderDir?: 'asc' | 'desc';
};

export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

/** One stored version: the inputs to bind and the definition they fill. */
export interface TemplateVersionPayload {
  version: number;
  inputs: TemplateInput[];
  definition: TemplateDefinition;
}

/** A catalog row, carrying the version it currently points at. */
export interface AutomationTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  group: TemplateGroup;
  kind: AutomationKind;
  builtin: boolean;
  source: 'builtin' | 'import' | 'local';
  author: string | null;
  currentVersion: number;
  usedBy: number;
  createdAt: string;
  updatedAt: string;
  version: TemplateVersionPayload;
}

/** A share code or a pasted envelope; the server accepts either. */
export interface TemplateImportBody {
  code?: string;
  envelope?: unknown;
  source?: 'local';
  replace?: string;
}

export interface TemplatePreview {
  envelope: TemplateEnvelope;
  fingerprint: string;
  existing?: {
    templateId: string;
    version: number;
    name: string;
    builtin: boolean;
    fingerprintMatch: boolean;
  };
  minServerVersion: { required: string; current: string; satisfied: boolean };
}

export interface InstantiateTemplateInput {
  inputs: Record<string, unknown>;
  name?: string;
  isActive?: boolean;
}

/** What both run reads filter on. */
export type RunFilterParams = Partial<
  Pick<RunListQuery, 'kind' | 'outcome' | 'automationId' | 'startDate' | 'endDate'>
>;

/** Run query params: the server's own filter schema plus paging and sort. */
export type RunListParams = RunFilterParams & {
  page?: number;
  pageSize?: number;
  orderBy?: RunSortField;
  orderDir?: 'asc' | 'desc';
};

/**
 * Query string for a list endpoint. `undefined` and `''` drop out; `false` stays,
 * because a false is a filter value (`acknowledged=false` is "pending only").
 */
function listSearchParams(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) searchParams.append(key, String(entry));
    } else {
      searchParams.set(key, String(value));
    }
  }
  return searchParams.toString();
}

export interface BulkViolationParams {
  ids?: string[];
  selectAll?: boolean;
  /** The filters the table was showing; a narrower set dismisses more
   *  violations than the user could see. */
  filters?: Partial<ViolationRosterFilters>;
}

// GET /library/media/:id/history has no shared-package response type yet (its
// query builder still returns the public v2 snake_case play shape rather than
// the internal camelCase convention other Task-18-era routes use) - minimal
// shape only, refine once a dedicated internal history type lands. `user` is
// typed to match mapHistoryRow's actual serialization (snake_case keys,
// username already resolved to identity name over server username).
export interface MediaHistoryPlayEntry {
  id: string;
  server_id: string;
  server_name: string;
  state: string;
  media_type: string;
  media_title: string;
  started_at: string;
  stopped_at: string | null;
  duration_ms: number | null;
  watched: boolean;
  user: {
    id: string;
    server_user_id: string;
    username: string;
    thumb_url: string | null;
    avatar_url: string | null;
  };
  [key: string]: unknown;
}

export interface MediaHistoryPageResponse {
  data: MediaHistoryPlayEntry[];
  meta: { nextCursor: string | null; pageSize: number };
}

export interface LibraryStatusResponse {
  isSynced: boolean;
  isSyncRunning: boolean;
  needsBackfill: boolean;
  isBackfillRunning: boolean;
  backfillState: 'active' | 'waiting' | 'delayed' | null;
  itemCount: number;
  snapshotCount: number;
  earliestItemDate: string | null;
  earliestSnapshotDate: string | null;
  backfillDays: number | null;
  /** True while items on the server still carry placeholder version rows;
   * a full library sync replaces them with observed file versions. */
  versionsBackfillPending: boolean;
}

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

// Minimal user echoed back by the Plex Better Auth plugin endpoints. The
// session cookie itself carries the full session; this is just enough for
// the login UI to know who signed in.
export interface PlexAuthUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface PlexCheckPinResponse {
  authorized: boolean;
  message?: string;
  // If returning user (or new user with no servers) - session cookie is already set
  user?: PlexAuthUser;
  // If new user (needs server selection)
  needsServerSelection?: boolean;
  servers?: PlexDiscoveredServer[]; // Now includes reachability info
  tempToken?: string;
}

export interface PlexConnectResponse {
  authorized: boolean;
  user: PlexAuthUser;
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

// Base URL for the API itself, e.g. "/api/v1" (or "/tracearr/api/v1" behind a subpath).
// Used by both ApiClient and authClient so they always target the same origin/basePath.
export const API_BASE_URL = `${BASE_PATH}${API_BASE_PATH}`;

/** Carries the response status so callers can distinguish e.g. a 404 from a network failure. */
export class ApiError extends Error {
  status: number;
  /** Parsed error body, for endpoints whose failure carries detail (a 409 delete lists the blocking rules). */
  body: Record<string, unknown>;

  constructor(message: string, status: number, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    // Only set Content-Type for requests with a body, but NOT for FormData
    // (browser sets correct Content-Type with boundary for multipart)
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      credentials: 'include',
      headers,
    });

    // A 401 means the session cookie is missing or expired - there's no token to
    // refresh anymore, so just clear the cached auth state and let the auth
    // context redirect to login. Skip this for auth endpoints where a 401/403
    // is an expected response (e.g. bad login credentials) rather than a lost
    // session. /auth/me is the probe the auth context uses to decide whether a
    // session exists at all, so its 401 while logged out is expected and must
    // not fire the logout event (that reloads the login page in a loop).
    const noAuthClearPaths = [
      '/auth/login',
      '/auth/signup',
      '/auth/logout',
      '/auth/me',
      '/auth/plex/check-pin',
      '/auth/callback',
    ];
    const shouldClearAuth = !noAuthClearPaths.some((p) => path.startsWith(p));
    if (response.status === 401 && shouldClearAuth) {
      window.dispatchEvent(
        new CustomEvent(AUTH_STATE_CHANGE_EVENT, { detail: { type: 'logout' } })
      );
    }

    // Detect maintenance mode (503 with maintenance flag)
    if (response.status === 503) {
      const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (errorBody.maintenance) {
        window.dispatchEvent(new CustomEvent(MAINTENANCE_EVENT));
        throw new Error('Server is in maintenance mode');
      }
      throw new Error(((errorBody.message ?? errorBody.error) as string) ?? 'Service Unavailable');
    }

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(
        ((errorBody.message ?? errorBody.error) as string) ?? `Request failed: ${response.status}`,
        response.status,
        errorBody
      );
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
    status: () => this.request<SetupStatus>('/setup/status'),
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

    // Validate claim code (stateless check for immediate feedback)
    validateClaimCode: (data: { claimCode: string }) =>
      this.request<{ success: boolean }>('/auth/validate-claim-code', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Plex OAuth - Step 1: Get PIN (Better Auth plugin endpoint - sets no cookie yet)
    initiatePlex: (forwardUrl?: string) =>
      this.request<{ pinId: string; authUrl: string }>('/auth/plex/initiate', {
        method: 'POST',
        body: JSON.stringify({ forwardUrl }),
      }),

    // Plex OAuth - Step 2: Check PIN. On success the session cookie is already
    // set server-side; the response just tells the UI what happened.
    checkPlexPin: (data: { pinId: string; claimCode?: string }) =>
      this.request<PlexCheckPinResponse>('/auth/plex/check-pin', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Plex OAuth - Step 3: Connect with selected server (only for setup)
    connectPlexServer: (data: {
      tempToken: string;
      serverUri: string;
      serverName: string;
      clientIdentifier?: string;
      claimCode?: string;
    }) =>
      this.request<PlexConnectResponse>('/auth/plex/connect', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Get available Plex servers (authenticated - for adding additional servers)
    getAvailablePlexServers: (accountId?: string) => {
      const params = accountId ? `?accountId=${accountId}` : '';
      return this.request<PlexAvailableServersResponse>(`/auth/plex/available-servers${params}`);
    },

    // Add an additional Plex server (authenticated - owner only)
    addPlexServer: (data: {
      serverUri: string;
      serverName: string;
      clientIdentifier: string;
      accountId?: string;
    }) =>
      this.request<{ server: Server; usersAdded: number; librariesSynced: number }>(
        '/auth/plex/add-server',
        {
          method: 'POST',
          body: JSON.stringify(data),
        }
      ),

    // Get linked Plex accounts (authenticated - owner only)
    getPlexAccounts: () => this.request<PlexAccountsResponse>('/auth/plex/accounts'),

    // Link a new Plex account via OAuth PIN (authenticated - owner only)
    linkPlexAccount: (pin: string) =>
      this.request<LinkPlexAccountResponse>('/auth/plex/link-account', {
        method: 'POST',
        body: JSON.stringify({ pin }),
      }),

    // Replace a linked Plex account's token via a fresh OAuth PIN (owner only)
    reauthorizePlexAccount: (accountId: string, pin: string) =>
      this.request<ReauthorizePlexAccountResponse>(`/auth/plex/accounts/${accountId}/reauthorize`, {
        method: 'POST',
        body: JSON.stringify({ pin }),
      }),

    // Unlink a Plex account (authenticated - owner only)
    unlinkPlexAccount: (id: string) =>
      this.request<UnlinkPlexAccountResponse>(`/auth/plex/accounts/${id}`, {
        method: 'DELETE',
      }),

    // Get connections for a specific Plex server (for editing URL)
    getPlexServerConnections: (serverId: string) =>
      this.request<{ server: PlexDiscoveredServer | null }>(
        `/auth/plex/server-connections/${serverId}`
      ),

    // Test reachability of a custom Plex URL before save. Accepts either an
    // authenticated owner session or a Plex signup tempToken (for Login.tsx).
    testPlexConnection: (data: {
      uri: string;
      accountId?: string;
      tempToken?: string;
      claimCode?: string;
    }) =>
      this.request<{ connection: PlexDiscoveredConnection }>('/auth/plex/test-connection', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

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
  };

  // Servers
  servers = {
    list: async () => {
      const response = await this.request<{ data: Server[] }>('/servers');
      return response.data;
    },
    create: (data: { name: string; type: string; url: string; token: string }) =>
      this.request<Server>('/servers', { method: 'POST', body: JSON.stringify(data) }),
    update: (
      id: string,
      data: { name?: string; url?: string; clientIdentifier?: string; color?: string | null }
    ) =>
      this.request<Server>(`/servers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(
          Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))
        ),
      }),
    /** @deprecated Use servers.update(id, { url, clientIdentifier }) */
    updateUrl: (id: string, url: string, clientIdentifier?: string) =>
      this.request<Server>(`/servers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ url, ...(clientIdentifier && { clientIdentifier }) }),
      }),
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
    reorder: (servers: { id: string; displayOrder: number }[]) =>
      this.request<{ success: boolean }>('/servers/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ servers }),
      }),
    liveStats: (id: string) =>
      this.request<{
        serverId: string;
        statistics: ServerResourceDataPoint[];
        bandwidth: ServerBandwidthDataPoint[];
        bandwidthSamples: BandwidthSample[];
        bandwidthAccounts: BandwidthAccount[];
        bandwidthDevices: BandwidthDevice[];
        fetchedAt: string;
      }>(`/servers/${id}/live-stats`),
    health: async () => {
      const response = await this.request<{
        data: { serverId: string; serverName: string }[];
      }>('/servers/health');
      return response.data;
    },
    connectionStatus: async () => {
      const response = await this.request<{ data: ServerConnectionStatus[] }>(
        '/servers/connection-status'
      );
      return response.data;
    },
  };

  // Users
  users = {
    list: (params: UserListParams = {}) => {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === false || value === '') continue;
        if (Array.isArray(value)) {
          for (const entry of value) searchParams.append(key, entry);
        } else {
          searchParams.set(key, String(value));
        }
      }
      return this.request<ListResponse<ServerUserWithIdentity>>(
        `/users?${searchParams.toString()}`
      );
    },
    get: (id: string) => this.request<ServerUserDetail>(`/users/${id}`),
    getFull: (id: string, params?: { scope?: 'identity' }) => {
      const query = new URLSearchParams();
      if (params?.scope) query.set('scope', params.scope);
      return this.request<ServerUserFullDetail>(`/users/${id}/full?${query.toString()}`);
    },
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
    sessions: (id: string, params?: { page?: number; pageSize?: number; scope?: 'identity' }) => {
      const query = new URLSearchParams(params as Record<string, string>).toString();
      return this.request<PaginatedResponse<Session>>(`/users/${id}/sessions?${query}`);
    },
    locations: async (id: string, params?: { scope?: 'identity' }) => {
      const query = new URLSearchParams();
      if (params?.scope) query.set('scope', params.scope);
      const response = await this.request<{ data: UserLocation[] }>(
        `/users/${id}/locations?${query.toString()}`
      );
      return response.data;
    },
    devices: async (id: string, params?: { scope?: 'identity' }) => {
      const query = new URLSearchParams();
      if (params?.scope) query.set('scope', params.scope);
      const response = await this.request<{ data: UserDevice[] }>(
        `/users/${id}/devices?${query.toString()}`
      );
      return response.data;
    },
    terminations: (
      id: string,
      params?: { page?: number; pageSize?: number; scope?: 'identity' }
    ) => {
      const query = new URLSearchParams(params as Record<string, string>).toString();
      return this.request<PaginatedResponse<TerminationLogWithDetails>>(
        `/users/${id}/terminations?${query}`
      );
    },
    bulkResetTrust: (params: {
      ids?: string[];
      selectAll?: boolean;
      /** The roster filters the table was showing; a narrower set resets more
       *  people than the user could see. */
      filters?: Partial<UserRosterFilters>;
    }) =>
      this.request<{ success: boolean; updated: number }>('/users/bulk/reset-trust', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    merge: (
      sourceUserId: string,
      data: { targetUserId: string; confirmSameServerCombine?: boolean }
    ) =>
      this.request<UserMergeResult>(`/users/${sourceUserId}/merge`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    mergeSuggestions: async () => {
      const response = await this.request<{ data: MergeSuggestion[] }>('/users/merge-suggestions');
      return response.data;
    },
  };

  // Server users (accounts on a specific media server)
  serverUsers = {
    split: (serverUserId: string) =>
      this.request<ServerUserSplitResult>(`/server-users/${serverUserId}/split`, {
        method: 'POST',
      }),
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
    history: (params: Partial<HistoryQueryInput> & { cursor?: string; serverIds?: string[] }) => {
      const searchParams = new URLSearchParams();
      if (params.cursor) searchParams.set('cursor', params.cursor);
      if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
      if (params.serverUserIds?.length)
        searchParams.set('serverUserIds', params.serverUserIds.join(','));
      if (params.serverIds?.length) {
        for (const id of params.serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      if (params.state) searchParams.set('state', params.state);
      if (params.mediaTypes?.length) searchParams.set('mediaTypes', params.mediaTypes.join(','));
      if (params.startDate) searchParams.set('startDate', params.startDate.toISOString());
      if (params.endDate) searchParams.set('endDate', params.endDate.toISOString());
      if (params.search) searchParams.set('search', params.search);
      if (params.platforms?.length) searchParams.set('platforms', params.platforms.join(','));
      if (params.product) searchParams.set('product', params.product);
      if (params.device) searchParams.set('device', params.device);
      if (params.playerName) searchParams.set('playerName', params.playerName);
      if (params.ipAddress) searchParams.set('ipAddress', params.ipAddress);
      if (params.geoCountries?.length)
        searchParams.set('geoCountries', params.geoCountries.join(','));
      if (params.geoCity) searchParams.set('geoCity', params.geoCity);
      if (params.geoRegion) searchParams.set('geoRegion', params.geoRegion);
      if (params.transcodeDecisions?.length)
        searchParams.set('transcodeDecisions', params.transcodeDecisions.join(','));
      if (params.watched !== undefined) searchParams.set('watched', String(params.watched));
      if (params.excludeShortSessions) searchParams.set('excludeShortSessions', 'true');
      if (params.orderBy) searchParams.set('orderBy', params.orderBy);
      if (params.orderDir) searchParams.set('orderDir', params.orderDir);
      return this.request<HistorySessionResponse>(`/sessions/history?${searchParams.toString()}`);
    },
    /**
     * Get aggregate stats for history (total plays, watch time, unique users/content).
     * Called separately from history() so sorting changes don't refetch these stats.
     */
    historyAggregates: (
      params: Partial<HistoryAggregatesQueryInput> & { serverIds?: string[] }
    ) => {
      const searchParams = new URLSearchParams();
      if (params.serverUserIds?.length)
        searchParams.set('serverUserIds', params.serverUserIds.join(','));
      if (params.serverIds?.length) {
        for (const id of params.serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      if (params.state) searchParams.set('state', params.state);
      if (params.mediaTypes?.length) searchParams.set('mediaTypes', params.mediaTypes.join(','));
      if (params.startDate) searchParams.set('startDate', params.startDate.toISOString());
      if (params.endDate) searchParams.set('endDate', params.endDate.toISOString());
      if (params.search) searchParams.set('search', params.search);
      if (params.platforms?.length) searchParams.set('platforms', params.platforms.join(','));
      if (params.product) searchParams.set('product', params.product);
      if (params.device) searchParams.set('device', params.device);
      if (params.playerName) searchParams.set('playerName', params.playerName);
      if (params.ipAddress) searchParams.set('ipAddress', params.ipAddress);
      if (params.geoCountries?.length)
        searchParams.set('geoCountries', params.geoCountries.join(','));
      if (params.geoCity) searchParams.set('geoCity', params.geoCity);
      if (params.geoRegion) searchParams.set('geoRegion', params.geoRegion);
      if (params.transcodeDecisions?.length)
        searchParams.set('transcodeDecisions', params.transcodeDecisions.join(','));
      if (params.watched !== undefined) searchParams.set('watched', String(params.watched));
      if (params.excludeShortSessions) searchParams.set('excludeShortSessions', 'true');
      return this.request<HistoryAggregates>(
        `/sessions/history/aggregates?${searchParams.toString()}`
      );
    },
    /**
     * Get available filter values for dropdowns on the History page.
     * Accepts optional date range to match history query filters.
     */
    filterOptions: (params?: { serverIds?: string[]; startDate?: Date; endDate?: Date }) => {
      const searchParams = new URLSearchParams();
      if (params?.serverIds?.length) {
        for (const id of params.serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      if (params?.startDate) searchParams.set('startDate', params.startDate.toISOString());
      if (params?.endDate) searchParams.set('endDate', params.endDate.toISOString());
      return this.request<HistoryFilterOptions>(
        `/sessions/filter-options?${searchParams.toString()}`
      );
    },
    /**
     * Get filter options for the automation builder.
     * Returns all countries (with hasSessions indicator) and servers.
     */
    automationFilterOptions: () => {
      return this.request<AutomationFilterOptions>(
        '/sessions/filter-options?includeAllCountries=true'
      );
    },
    getActive: async (serverIds?: string[]) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      const query = params.toString();
      const response = await this.request<{ data: ActiveSession[] }>(
        `/sessions/active${query ? `?${query}` : ''}`
      );
      return response.data;
    },
    get: (id: string) => this.request<SessionWithDetails>(`/sessions/${id}`),
    terminate: (id: string, reason?: string) =>
      this.request<{ success: boolean; terminationLogId: string; message: string }>(
        `/sessions/${id}/terminate`,
        { method: 'POST', body: JSON.stringify({ reason }) }
      ),
    bulkDelete: (ids: string[]) =>
      this.request<{ success: boolean; deleted: number }>('/sessions/bulk', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      }),
  };

  // Automations
  automations = {
    list: (params: AutomationListParams = {}) =>
      this.request<ListResponse<Automation>>(`/automations?${listSearchParams(params)}`),
    get: (id: string) => this.request<Automation>(`/automations/${id}`),
    create: (data: CreateAutomationInput) =>
      this.request<Automation>('/automations', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: UpdateAutomationInput) =>
      this.request<Automation>(`/automations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) => this.request<void>(`/automations/${id}`, { method: 'DELETE' }),
    /** Re-answers what a bound row's template asked; the server re-materializes the definition. */
    rebind: (id: string, templateInputs: Record<string, unknown>) =>
      this.request<Automation>(`/automations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ templateInputs }),
      }),
    /** What a draft would do against the sessions playing now; nothing is recorded. */
    dryRun: (data: DryRunRequest) =>
      this.request<DryRunResponse>('/automations/dry-run', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    bulkUpdate: (ids: string[], isActive: boolean) =>
      this.request<{ success: boolean; updated: number }>('/automations/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ ids, isActive }),
      }),
    bulkDelete: (ids: string[]) =>
      this.request<{ success: boolean; deleted: number }>('/automations/bulk', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      }),
    /** The automation as an envelope plus the code that carries it. */
    export: (id: string, author?: string, group?: TemplateGroup) => {
      const query = listSearchParams({ author, group });
      return this.request<{ envelope: TemplateEnvelope; code: string }>(
        `/automations/${id}/export${query ? `?${query}` : ''}`
      );
    },
    detach: (id: string) =>
      this.request<Automation>(`/automations/${id}/detach`, { method: 'POST' }),
    upgrade: (id: string, inputs: Record<string, unknown>) =>
      this.request<Automation>(`/automations/${id}/upgrade`, {
        method: 'POST',
        body: JSON.stringify({ inputs }),
      }),
  };

  // Automation templates
  templates = {
    list: () => this.request<{ data: AutomationTemplate[] }>('/templates'),
    get: (id: string) => this.request<AutomationTemplate>(`/templates/${id}`),
    /** One stored version, however old: what a row pinned to it still says. */
    getVersion: (id: string, version: number) =>
      this.request<TemplateVersionPayload>(`/templates/${id}/versions/${version}`),
    /** What an import would land on; nothing is written. */
    preview: (body: TemplateImportBody) =>
      this.request<TemplatePreview>('/templates/preview', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    create: (body: TemplateImportBody) =>
      this.request<AutomationTemplate>('/templates', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    instantiate: (id: string, body: InstantiateTemplateInput) =>
      this.request<Automation>(`/templates/${id}/instantiate`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  };

  // Automation runs
  runs = {
    get: (id: string) => this.request<AutomationRun>(`/runs/${id}`),
    listForAutomation: (automationId: string, params: RunListParams = {}) =>
      this.request<ListResponse<AutomationRunSummary>>(
        `/automations/${automationId}/runs?${listSearchParams(params)}`
      ),
    /** How many runs each outcome holds, for the Activity tabs. */
    counts: (params: RunFilterParams = {}) =>
      this.request<RunCounts>(`/runs/counts?${listSearchParams(params)}`),
    /** The capped near-miss ring, newest first. */
    evaluations: (automationId: string) =>
      this.request<{ data: NearMissEntry[] }>(`/automations/${automationId}/evaluations`),
  };

  // Violations
  violations = {
    get: (id: string) => this.request<ViolationWithDetails>(`/violations/${id}`),
    list: (params: ViolationListParams = {}) =>
      this.request<ListResponse<ViolationWithDetails>>(`/violations?${listSearchParams(params)}`),
    acknowledge: (id: string) =>
      this.request<{ success: boolean; acknowledgedAt: Date | null }>(`/violations/${id}`, {
        method: 'PATCH',
        body: '{}',
      }),
    dismiss: (id: string) => this.request<void>(`/violations/${id}`, { method: 'DELETE' }),
    bulkAcknowledge: (params: BulkViolationParams) =>
      this.request<{ success: boolean; acknowledged: number }>('/violations/bulk/acknowledge', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    bulkDismiss: (params: BulkViolationParams) =>
      this.request<{ success: boolean; dismissed: number }>('/violations/bulk', {
        method: 'DELETE',
        body: JSON.stringify(params),
      }),
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

  // Variant that serializes repeatable serverIds (precedence over legacy serverId)
  private buildStatsParamsMulti(timeRange?: StatsTimeRange, serverIds?: string[]): URLSearchParams {
    const params = new URLSearchParams();
    if (timeRange?.period) params.set('period', timeRange.period);
    if (timeRange?.startDate) params.set('startDate', timeRange.startDate);
    if (timeRange?.endDate) params.set('endDate', timeRange.endDate);
    if (serverIds?.length) {
      for (const id of serverIds) {
        params.append('serverIds', id);
      }
    }
    params.set('timezone', timeRange?.timezone ?? getBrowserTimezone());
    return params;
  }

  stats = {
    dashboard: (serverIds?: string[]) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      // Include timezone so "today" is calculated in user's local timezone
      params.set('timezone', getBrowserTimezone());
      return this.request<DashboardStats>(`/stats/dashboard?${params.toString()}`);
    },
    plays: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'week' }, serverIds);
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
      serverUserIds?: string[];
      serverIds?: string[];
      mediaType?: 'movie' | 'episode' | 'track';
    }) => {
      const searchParams = new URLSearchParams();
      if (params?.timeRange?.period) searchParams.set('period', params.timeRange.period);
      if (params?.timeRange?.startDate) searchParams.set('startDate', params.timeRange.startDate);
      if (params?.timeRange?.endDate) searchParams.set('endDate', params.timeRange.endDate);
      if (params?.serverUserIds?.length) {
        searchParams.set('serverUserIds', params.serverUserIds.join(','));
      } else if (params?.serverUserId) {
        searchParams.set('serverUserId', params.serverUserId);
      }
      if (params?.serverIds?.length) {
        for (const id of params.serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      if (params?.mediaType) searchParams.set('mediaType', params.mediaType);
      const query = searchParams.toString();
      return this.request<LocationStatsResponse>(`/stats/locations${query ? `?${query}` : ''}`);
    },
    playsByDayOfWeek: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      const response = await this.request<{ data: { day: number; name: string; count: number }[] }>(
        `/stats/plays-by-dayofweek?${params.toString()}`
      );
      return response.data;
    },
    playsByHourOfDay: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      const response = await this.request<{ data: { hour: number; count: number }[] }>(
        `/stats/plays-by-hourofday?${params.toString()}`
      );
      return response.data;
    },
    platforms: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      const response = await this.request<{ data: { platform: string | null; count: number }[] }>(
        `/stats/platforms?${params.toString()}`
      );
      return response.data;
    },
    quality: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      return this.request<{
        directPlay: number;
        directStream: number;
        transcode: number;
        total: number;
        directPlayPercent: number;
        directStreamPercent: number;
        transcodePercent: number;
      }>(`/stats/quality?${params.toString()}`);
    },
    topUsers: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      const response = await this.request<{ data: TopUserStats[] }>(
        `/stats/top-users?${params.toString()}`
      );
      return response.data;
    },
    topContent: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
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
    concurrent: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      const response = await this.request<{
        data: {
          hour: string;
          total: number;
          direct: number;
          directStream: number;
          transcode: number;
        }[];
      }>(`/stats/concurrent?${params.toString()}`);
      return response.data;
    },
    engagement: async (
      timeRange?: StatsTimeRange,
      serverIds?: string[],
      options?: { mediaType?: MediaType; limit?: number }
    ) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'week' }, serverIds);
      if (options?.mediaType) params.set('mediaType', options.mediaType);
      if (options?.limit) params.set('limit', String(options.limit));
      return this.request<EngagementStats>(`/stats/engagement?${params.toString()}`);
    },
    shows: async (
      timeRange?: StatsTimeRange,
      serverIds?: string[],
      options?: {
        limit?: number;
        orderBy?: 'totalEpisodeViews' | 'totalWatchHours' | 'bingeScore' | 'uniqueViewers';
      }
    ) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.orderBy) params.set('orderBy', options.orderBy);
      return this.request<ShowStatsResponse>(`/stats/shows?${params.toString()}`);
    },

    // Device compatibility stats
    deviceCompatibility: async (
      timeRange?: StatsTimeRange,
      serverIds?: string[],
      minSessions = 5
    ) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      params.set('minSessions', String(minSessions));
      return this.request<DeviceCompatibilityResponse>(
        `/stats/device-compatibility?${params.toString()}`
      );
    },
    deviceCompatibilityMatrix: async (
      timeRange?: StatsTimeRange,
      serverId?: string,
      minSessions = 5
    ) => {
      const params = this.buildStatsParams(timeRange ?? { period: 'month' }, serverId);
      params.set('minSessions', String(minSessions));
      return this.request<DeviceCompatibilityMatrix>(
        `/stats/device-compatibility/matrix?${params.toString()}`
      );
    },
    // Batches every selected server into one request, keyed by server id.
    deviceCompatibilityMatrixMulti: async (
      timeRange?: StatsTimeRange,
      serverIds?: string[],
      minSessions = 5
    ) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      params.set('minSessions', String(minSessions));
      return this.request<Record<string, DeviceCompatibilityMatrix>>(
        `/stats/device-compatibility/matrix?${params.toString()}`
      );
    },
    deviceHealth: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      return this.request<DeviceHealthResponse>(
        `/stats/device-compatibility/health?${params.toString()}`
      );
    },
    transcodeHotspots: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      return this.request<TranscodeHotspotsResponse>(
        `/stats/device-compatibility/hotspots?${params.toString()}`
      );
    },
    topTranscodingUsers: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      return this.request<TopTranscodingUsersResponse>(
        `/stats/device-compatibility/top-transcoding-users?${params.toString()}`
      );
    },

    // Bandwidth stats
    bandwidthDaily: async (
      timeRange?: StatsTimeRange,
      serverIds?: string[],
      serverUserId?: string
    ) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      if (serverUserId) params.set('serverUserId', serverUserId);
      return this.request<DailyBandwidthResponse>(`/stats/bandwidth/daily?${params.toString()}`);
    },
    bandwidthTopUsers: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      return this.request<BandwidthTopUsersResponse>(
        `/stats/bandwidth/top-users?${params.toString()}`
      );
    },
    bandwidthSummary: async (timeRange?: StatsTimeRange, serverIds?: string[]) => {
      const params = this.buildStatsParamsMulti(timeRange ?? { period: 'month' }, serverIds);
      return this.request<BandwidthSummary>(`/stats/bandwidth/summary?${params.toString()}`);
    },
  };

  // Library statistics - data fetching for library analytics pages
  library = {
    stats: (serverIds?: string[], libraryId?: string) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      if (libraryId) params.set('libraryId', libraryId);
      params.set('timezone', getBrowserTimezone());
      return this.request<LibraryStatsResponse>(`/library/stats?${params.toString()}`);
    },
    growth: (
      serverIds?: string[],
      libraryId?: string,
      period: string = '30d',
      startDate?: string,
      endDate?: string
    ) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      if (libraryId) params.set('libraryId', libraryId);
      params.set('period', period);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      params.set('timezone', getBrowserTimezone());
      return this.request<LibraryGrowthResponse>(`/library/growth?${params.toString()}`);
    },
    quality: (
      serverId?: string,
      period: string = '30d',
      mediaType: 'all' | 'movies' | 'shows' = 'all'
    ) => {
      const params = new URLSearchParams();
      if (serverId) params.set('serverId', serverId);
      params.set('period', period);
      params.set('mediaType', mediaType);
      params.set('timezone', getBrowserTimezone());
      return this.request<LibraryQualityResponse>(`/library/quality?${params.toString()}`);
    },
    storage: (serverId?: string, libraryId?: string, period: string = '30d') => {
      const params = new URLSearchParams();
      if (serverId) params.set('serverId', serverId);
      if (libraryId) params.set('libraryId', libraryId);
      params.set('period', period);
      params.set('timezone', getBrowserTimezone());
      return this.request<LibraryStorageResponse>(`/library/storage?${params.toString()}`);
    },
    // Scoped variant: one request over the whole selection, so the server's
    // mirror dedup sees every server at once instead of per-server sums
    storageScoped: (serverIds: string[], period: string = '30d') => {
      const params = new URLSearchParams();
      for (const id of serverIds) {
        params.append('serverIds', id);
      }
      params.set('period', period);
      params.set('timezone', getBrowserTimezone());
      return this.request<LibraryStorageResponse>(`/library/storage?${params.toString()}`);
    },
    duplicates: (serverIds?: string[], page: number = 1, pageSize: number = 20) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      return this.request<DuplicatesResponse>(`/library/duplicates?${params.toString()}`);
    },
    stale: (
      serverIds?: string[],
      libraryId?: string,
      staleDays: number = 90,
      category: 'all' | 'never_watched' | 'stale' = 'all',
      page: number = 1,
      pageSize: number = 20,
      mediaType?: 'movie' | 'show' | 'artist',
      sortBy: 'size' | 'title' | 'days_stale' | 'added_at' = 'size',
      sortOrder: 'asc' | 'desc' = 'desc'
    ) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      if (libraryId) params.set('libraryId', libraryId);
      params.set('staleDays', String(staleDays));
      params.set('category', category);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (mediaType) params.set('mediaType', mediaType);
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      return this.request<StaleResponse>(`/library/stale?${params.toString()}`);
    },
    watch: (serverIds?: string[], libraryId?: string, page: number = 1, pageSize: number = 20) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      if (libraryId) params.set('libraryId', libraryId);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      return this.request<WatchResponse>(`/library/watch?${params.toString()}`);
    },
    completion: (
      serverId?: string,
      libraryId?: string,
      aggregateLevel: string = 'item',
      page: number = 1,
      pageSize: number = 20,
      mediaType?: 'movie' | 'episode'
    ) => {
      const params = new URLSearchParams();
      if (serverId) params.set('serverId', serverId);
      if (libraryId) params.set('libraryId', libraryId);
      params.set('aggregateLevel', aggregateLevel);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (mediaType) params.set('mediaType', mediaType);
      return this.request<CompletionResponse>(`/library/completion?${params.toString()}`);
    },
    patterns: (serverIds?: string[], libraryId?: string, periodWeeks: number = 12) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      if (libraryId) params.set('libraryId', libraryId);
      params.set('periodWeeks', String(periodWeeks));
      params.set('timezone', getBrowserTimezone());
      return this.request<PatternsResponse>(`/library/patterns?${params.toString()}`);
    },
    roi: (
      serverIds?: string[],
      libraryId?: string,
      page: number = 1,
      pageSize: number = 20,
      mediaType?: 'movie' | 'show' | 'artist',
      sortBy: 'watch_hours_per_gb' | 'value_score' | 'file_size' | 'title' = 'watch_hours_per_gb',
      sortOrder: 'asc' | 'desc' = 'asc'
    ) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      if (libraryId) params.set('libraryId', libraryId);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (mediaType) params.set('mediaType', mediaType);
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      params.set('timezone', getBrowserTimezone());
      return this.request<RoiResponse>(`/library/roi?${params.toString()}`);
    },
    topMovies: (
      serverIds?: string[],
      period: string = '30d',
      sortBy: string = 'plays',
      sortOrder: string = 'desc',
      page: number = 1,
      pageSize: number = 20
    ) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      params.set('period', period);
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      return this.request<TopMoviesResponse>(`/library/top-movies?${params.toString()}`);
    },
    topShows: (
      serverIds?: string[],
      period: string = '30d',
      sortBy: string = 'plays',
      sortOrder: string = 'desc',
      page: number = 1,
      pageSize: number = 20
    ) => {
      const params = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          params.append('serverIds', id);
        }
      }
      params.set('period', period);
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      return this.request<TopShowsResponse>(`/library/top-shows?${params.toString()}`);
    },
    codecs: (serverId?: string, libraryId?: string) => {
      const params = new URLSearchParams();
      if (serverId) params.set('serverId', serverId);
      if (libraryId) params.set('libraryId', libraryId);
      return this.request<LibraryCodecsResponse>(`/library/codecs?${params.toString()}`);
    },
    resolution: (serverId?: string, libraryId?: string) => {
      const params = new URLSearchParams();
      if (serverId) params.set('serverId', serverId);
      if (libraryId) params.set('libraryId', libraryId);
      return this.request<LibraryResolutionResponse>(`/library/resolution?${params.toString()}`);
    },
    status: (serverIds: string[]) => {
      const params = new URLSearchParams();
      for (const id of serverIds) {
        params.append('serverIds', id);
      }
      return this.request<Record<string, LibraryStatusResponse>>(
        `/library/status?${params.toString()}`
      );
    },
    catalog: (params: {
      type: 'movie' | 'show';
      serverIds?: string[];
      resolution?: string;
      genre?: string;
      yearFrom?: number;
      yearTo?: number;
      watched?: WatchedState;
      lens?: string;
      search?: string;
      sort?: 'title' | 'added' | 'year' | 'plays' | 'watch_time' | 'viewers';
      offset?: number;
      pageSize?: number;
      libraryKey?: string;
      hdr?: boolean;
      sizeGbMin?: number;
      sizeGbMax?: number;
    }) => {
      const searchParams = new URLSearchParams();
      searchParams.set('type', params.type);
      if (params.serverIds?.length) {
        for (const id of params.serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      if (params.resolution) searchParams.set('resolution', params.resolution);
      if (params.genre) searchParams.set('genre', params.genre);
      if (params.yearFrom !== undefined) searchParams.set('yearFrom', String(params.yearFrom));
      if (params.yearTo !== undefined) searchParams.set('yearTo', String(params.yearTo));
      if (params.watched) searchParams.set('watched', params.watched);
      if (params.lens) searchParams.set('lens', params.lens);
      if (params.search) searchParams.set('search', params.search);
      if (params.sort) searchParams.set('sort', params.sort);
      if (params.offset !== undefined) searchParams.set('offset', String(params.offset));
      if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
      if (params.libraryKey) searchParams.set('libraryKey', params.libraryKey);
      if (params.hdr) searchParams.set('hdr', 'true');
      if (params.sizeGbMin !== undefined) searchParams.set('sizeGbMin', String(params.sizeGbMin));
      if (params.sizeGbMax !== undefined) searchParams.set('sizeGbMax', String(params.sizeGbMax));
      return this.request<CatalogResponse>(`/library/catalog?${searchParams.toString()}`);
    },
    catalogLetters: (params: {
      type: 'movie' | 'show';
      serverIds?: string[];
      resolution?: string;
      genre?: string;
      yearFrom?: number;
      yearTo?: number;
      watched?: WatchedState;
      lens?: string;
      search?: string;
      sort?: 'title' | 'added' | 'year' | 'plays' | 'watch_time' | 'viewers';
      libraryKey?: string;
      hdr?: boolean;
      sizeGbMin?: number;
      sizeGbMax?: number;
    }) => {
      const searchParams = new URLSearchParams();
      searchParams.set('type', params.type);
      if (params.serverIds?.length) {
        for (const id of params.serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      if (params.resolution) searchParams.set('resolution', params.resolution);
      if (params.genre) searchParams.set('genre', params.genre);
      if (params.yearFrom !== undefined) searchParams.set('yearFrom', String(params.yearFrom));
      if (params.yearTo !== undefined) searchParams.set('yearTo', String(params.yearTo));
      if (params.watched) searchParams.set('watched', params.watched);
      if (params.lens) searchParams.set('lens', params.lens);
      if (params.search) searchParams.set('search', params.search);
      if (params.sort) searchParams.set('sort', params.sort);
      if (params.libraryKey) searchParams.set('libraryKey', params.libraryKey);
      if (params.hdr) searchParams.set('hdr', 'true');
      if (params.sizeGbMin !== undefined) searchParams.set('sizeGbMin', String(params.sizeGbMin));
      if (params.sizeGbMax !== undefined) searchParams.set('sizeGbMax', String(params.sizeGbMax));
      return this.request<CatalogLettersResponse>(
        `/library/catalog/letters?${searchParams.toString()}`
      );
    },
    shelves: (
      params: {
        timeRange?: StatsTimeRange;
        serverIds?: string[];
        includeDeadWeight?: boolean;
      } = {}
    ) => {
      const searchParams = new URLSearchParams();
      if (params.timeRange?.period) searchParams.set('period', params.timeRange.period);
      if (params.timeRange?.startDate) searchParams.set('startDate', params.timeRange.startDate);
      if (params.timeRange?.endDate) searchParams.set('endDate', params.timeRange.endDate);
      if (params.includeDeadWeight === false) searchParams.set('includeDeadWeight', 'false');
      if (params.serverIds?.length) {
        for (const id of params.serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      return this.request<ShelvesResponse>(`/library/shelves?${searchParams.toString()}`);
    },
    genres: (type: 'movie' | 'show', serverIds?: string[]) => {
      const searchParams = new URLSearchParams();
      searchParams.set('type', type);
      if (serverIds?.length) {
        for (const id of serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      return this.request<GenresResponse>(`/library/genres?${searchParams.toString()}`);
    },
    libraries: (serverIds?: string[]) => {
      const searchParams = new URLSearchParams();
      if (serverIds?.length) {
        for (const id of serverIds) {
          searchParams.append('serverIds', id);
        }
      }
      return this.request<LibrariesResponse>(`/library/libraries?${searchParams.toString()}`);
    },
    media: {
      detail: (id: string, serverIds?: string[]) => {
        const searchParams = new URLSearchParams();
        if (serverIds?.length) {
          for (const serverId of serverIds) {
            searchParams.append('serverIds', serverId);
          }
        }
        const query = searchParams.toString();
        return this.request<MediaDetailResponse>(`/library/media/${id}${query ? `?${query}` : ''}`);
      },
      children: (id: string, serverIds?: string[]) => {
        const searchParams = new URLSearchParams();
        if (serverIds?.length) {
          for (const serverId of serverIds) {
            searchParams.append('serverIds', serverId);
          }
        }
        const query = searchParams.toString();
        return this.request<MediaChildrenResponse>(
          `/library/media/${id}/children${query ? `?${query}` : ''}`
        );
      },
      stats: (id: string, serverIds?: string[]) => {
        const searchParams = new URLSearchParams();
        if (serverIds?.length) {
          for (const serverId of serverIds) {
            searchParams.append('serverIds', serverId);
          }
        }
        const query = searchParams.toString();
        return this.request<MediaStatsResponse>(
          `/library/media/${id}/stats${query ? `?${query}` : ''}`
        );
      },
      watchers: (id: string, window?: 'all_time' | 'last_30' | 'last_7', serverIds?: string[]) => {
        const searchParams = new URLSearchParams();
        if (window) searchParams.set('window', window);
        if (serverIds?.length) {
          for (const serverId of serverIds) {
            searchParams.append('serverIds', serverId);
          }
        }
        return this.request<MediaWatchersResponse>(
          `/library/media/${id}/watchers?${searchParams.toString()}`
        );
      },
      history: (id: string, cursor?: string, pageSize?: number, serverIds?: string[]) => {
        const searchParams = new URLSearchParams();
        if (cursor) searchParams.set('cursor', cursor);
        if (pageSize) searchParams.set('pageSize', String(pageSize));
        if (serverIds?.length) {
          for (const serverId of serverIds) {
            searchParams.append('serverIds', serverId);
          }
        }
        return this.request<MediaHistoryPageResponse>(
          `/library/media/${id}/history?${searchParams.toString()}`
        );
      },
      platforms: (id: string, serverIds?: string[]) => {
        const searchParams = new URLSearchParams();
        if (serverIds?.length) {
          for (const serverId of serverIds) {
            searchParams.append('serverIds', serverId);
          }
        }
        const query = searchParams.toString();
        return this.request<MediaPlatformBreakdownResponse>(
          `/library/media/${id}/platforms${query ? `?${query}` : ''}`
        );
      },
      seasonHeat: (id: string, serverIds?: string[]) => {
        const searchParams = new URLSearchParams();
        if (serverIds?.length) {
          for (const serverId of serverIds) {
            searchParams.append('serverIds', serverId);
          }
        }
        const query = searchParams.toString();
        return this.request<MediaSeasonHeatResponse>(
          `/library/media/${id}/season-heat${query ? `?${query}` : ''}`
        );
      },
    },
  };

  // Settings
  settings = {
    get: () => this.request<Settings>('/settings'),
    update: (data: Partial<Settings>) =>
      this.request<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),
    getApiKey: () => this.request<{ token: string | null }>('/settings/api-key'),
    regenerateApiKey: () =>
      this.request<{ token: string }>('/settings/api-key/regenerate', { method: 'POST' }),
    getIpWarning: () =>
      this.request<{ showWarning: boolean; stateHash: string }>('/settings/ip-warning'),
    getImageCache: () => this.request<ImageCacheStatus>('/settings/image-cache'),
  };

  map = {
    getBasemapStatus: () =>
      this.request<{ installed: boolean; path: string }>('/map/basemap/status'),
  };

  // Notification destinations
  destinations = {
    list: () => this.request<Destination[]>('/destinations'),
    create: (data: CreateDestinationInput) =>
      this.request<Destination>('/destinations', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: UpdateDestinationInput) =>
      this.request<Destination>(`/destinations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    remove: (id: string) => this.request<void>(`/destinations/${id}`, { method: 'DELETE' }),
    test: (id: string) =>
      this.request<{ success: boolean; error?: string }>(`/destinations/${id}/test`, {
        method: 'POST',
      }),
    testUnsaved: (data: { type: DestinationKind; config: Record<string, unknown> }) =>
      this.request<{ success: boolean; error?: string }>('/destinations/test', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  };

  // Import
  import = {
    tautulli: {
      test: (url: string, apiKey: string, basicAuth?: { username: string; password: string }) =>
        this.request<{
          success: boolean;
          message: string;
          users?: number;
          historyRecords?: number;
        }>('/import/tautulli/test', {
          method: 'POST',
          body: JSON.stringify({
            url,
            apiKey,
            basicAuthUsername: basicAuth?.username,
            basicAuthPassword: basicAuth?.password,
          }),
        }),
      start: (
        serverId: string,
        overwriteFriendlyNames: boolean = false,
        includeStreamDetails: boolean = false
      ) =>
        this.request<{ status: string; jobId?: string; message: string }>('/import/tautulli', {
          method: 'POST',
          body: JSON.stringify({ serverId, overwriteFriendlyNames, includeStreamDetails }),
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
    jellystat: {
      /**
       * Start Jellystat import from backup file
       * @param serverId - Target Jellyfin/Emby server
       * @param file - Jellystat backup JSON file
       * @param enrichMedia - Whether to enrich with metadata (default: true)
       * @param updateStreamDetails - Whether to update existing records with stream data (default: false)
       */
      start: async (
        serverId: string,
        file: File,
        enrichMedia: boolean = true,
        updateStreamDetails: boolean = false
      ) => {
        const formData = new FormData();
        // Fields must come BEFORE file - @fastify/multipart stops parsing after file
        formData.append('serverId', serverId);
        formData.append('enrichMedia', String(enrichMedia));
        formData.append('updateStreamDetails', String(updateStreamDetails));
        formData.append('file', file);

        return this.request<{ status: string; jobId?: string; message: string }>(
          '/import/jellystat',
          {
            method: 'POST',
            body: formData,
            headers: {}, // Let browser set Content-Type with boundary for multipart
          }
        );
      },
      getActive: (serverId: string) =>
        this.request<{
          active: boolean;
          jobId?: string;
          state?: string;
          progress?: number | object;
          createdAt?: number;
        }>(`/import/jellystat/active/${serverId}`),
      getStatus: (jobId: string) =>
        this.request<{
          jobId: string;
          state: string;
          progress: number | object | null;
          result?: {
            success: boolean;
            imported: number;
            updated: number;
            skipped: number;
            errors: number;
            enriched: number;
            message: string;
          };
          failedReason?: string;
          createdAt?: number;
          finishedAt?: number;
        }>(`/import/jellystat/${jobId}`),
      cancel: (jobId: string) =>
        this.request<{ status: string; jobId: string }>(`/import/jellystat/${jobId}`, {
          method: 'DELETE',
        }),
    },
    playbackReporting: {
      test: (serverId: string) =>
        this.request<{
          success: boolean;
          installed: boolean;
          message: string;
          records?: number;
          oldestDate?: string;
          newestDate?: string;
        }>('/import/playback-reporting/test', {
          method: 'POST',
          body: JSON.stringify({ serverId }),
        }),
      start: (
        serverId: string,
        timezone: string,
        enrichMedia: boolean = true,
        importFullRange: boolean = false
      ) =>
        this.request<{ status: string; jobId?: string; message: string }>(
          '/import/playback-reporting',
          {
            method: 'POST',
            body: JSON.stringify({ serverId, timezone, enrichMedia, importFullRange }),
          }
        ),
      getActive: (serverId: string) =>
        this.request<{
          active: boolean;
          jobId?: string;
          state?: string;
          progress?: number | object;
          createdAt?: number;
        }>(`/import/playback-reporting/active/${serverId}`),
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
        }>(`/import/playback-reporting/${jobId}`),
      cancel: (jobId: string) =>
        this.request<{ status: string; jobId: string }>(`/import/playback-reporting/${jobId}`, {
          method: 'DELETE',
        }),
    },
  };

  // Maintenance jobs
  maintenance = {
    getJobs: () =>
      this.request<{
        jobs: Array<{
          type: string;
          category: 'normalization' | 'backfill' | 'cleanup';
          name: string;
          description: string;
          options?: Array<{
            name: string;
            label: string;
            description: string;
            type: 'boolean';
            default: boolean;
          }>;
        }>;
      }>('/maintenance/jobs'),
    startJob: (type: string, options?: { fullRefresh?: boolean }) =>
      this.request<{ status: string; jobId: string; message: string }>(
        `/maintenance/jobs/${type}`,
        {
          method: 'POST',
          body: JSON.stringify(options ?? {}),
        }
      ),
    getProgress: () =>
      this.request<{
        progress: {
          type: string;
          status: string;
          totalRecords: number;
          processedRecords: number;
          updatedRecords: number;
          skippedRecords: number;
          errorRecords: number;
          message: string;
          startedAt?: string;
          completedAt?: string;
        } | null;
      }>('/maintenance/progress'),
    getJobStatus: (jobId: string) =>
      this.request<{
        jobId: string;
        state: string;
        progress: number | object | null;
        result?: {
          success: boolean;
          type: string;
          processed: number;
          updated: number;
          skipped: number;
          errors: number;
          durationMs: number;
          message: string;
        };
        failedReason?: string;
        createdAt?: number;
        finishedAt?: number;
      }>(`/maintenance/jobs/${jobId}/status`),
    getStats: () =>
      this.request<{
        waiting: number;
        active: number;
        completed: number;
        failed: number;
        delayed: number;
      }>('/maintenance/stats'),
    getHistory: () =>
      this.request<{
        history: Array<{
          jobId: string;
          type: string;
          state: string;
          createdAt: number;
          finishedAt?: number;
          result?: {
            success: boolean;
            type: string;
            processed: number;
            updated: number;
            skipped: number;
            errors: number;
            durationMs: number;
            message: string;
          };
        }>;
      }>('/maintenance/history'),
    getSnapshots: (params?: { suspicious?: boolean; date?: string; libraryId?: string }) => {
      const queryParams = new URLSearchParams();
      if (params?.suspicious) queryParams.set('suspicious', 'true');
      if (params?.date) queryParams.set('date', params.date);
      if (params?.libraryId) queryParams.set('libraryId', params.libraryId);
      const query = queryParams.toString();
      return this.request<{
        snapshots: Array<{
          id: string;
          server_id: string;
          server_name: string | null;
          library_id: string;
          library_type: string;
          snapshot_time: string;
          item_count: number;
          total_size: string;
          movie_count: number;
          episode_count: number;
          music_count: number;
          is_suspicious: boolean;
        }>;
        count: number;
      }>(`/maintenance/snapshots${query ? `?${query}` : ''}`);
    },
    deleteSnapshots: (params: {
      ids?: string[];
      criteria?: { suspicious?: boolean; date?: string; libraryId?: string };
    }) =>
      this.request<{ deleted: number; message: string }>('/maintenance/snapshots', {
        method: 'DELETE',
        body: JSON.stringify(params),
      }),
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
    updateSession: (id: string, data: { deviceName: string }) =>
      this.request<{
        data: {
          id: string;
          deviceName: string;
          deviceId: string;
          platform: string;
          lastSeenAt: string;
          createdAt: string;
        };
      }>(`/mobile/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
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

  // Tailscale VPN
  tailscale = {
    getStatus: () => this.request<TailscaleInfo>('/tailscale/status'),
    enable: (hostname?: string) =>
      this.request<TailscaleInfo>('/tailscale/enable', {
        method: 'POST',
        body: JSON.stringify({ hostname }),
      }),
    disable: () =>
      this.request<TailscaleInfo>('/tailscale/disable', { method: 'POST', body: '{}' }),
    reset: () => this.request<TailscaleInfo>('/tailscale/reset', { method: 'POST', body: '{}' }),
    // Exit node disabled - this will come back when we implement SOCKS proxy support
    // setExitNode: (id: string | null) =>
    //   this.request<TailscaleInfo>('/tailscale/exit-node', {
    //     method: 'POST',
    //     body: JSON.stringify({ id }),
    //   }),
    getLogs: () => this.request<{ logs: string }>('/tailscale/logs'),
  };

  // Running tasks
  tasks = {
    getRunning: () => this.request<RunningTasksResponse>('/tasks/running'),
  };

  // Backup & Restore
  backup = {
    create: () =>
      this.request<{ filename: string; metadata: BackupMetadata }>('/backup/create', {
        method: 'POST',
      }),
    upload: (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return this.request<{ filename: string; metadata: BackupMetadata }>('/backup/upload', {
        method: 'POST',
        body: formData,
      });
    },
    list: () => this.request<BackupListItem[]>('/backup/list'),
    download: async (filename: string) => {
      const { token } = await this.request<{ token: string }>(
        `/backup/download-token/${filename}`,
        { method: 'POST' }
      );
      window.open(`${this.baseUrl}/backup/download/${filename}?token=${token}`, '_blank');
    },
    deleteBackup: (filename: string) =>
      this.request<{ success: boolean }>(`/backup/${filename}`, { method: 'DELETE' }),
    restore: (filename: string) =>
      this.request<{ valid: boolean; metadata: BackupMetadata }>('/backup/restore', {
        method: 'POST',
        body: JSON.stringify({ filename }),
      }),
    getInfo: () =>
      this.request<{
        backupDir: string;
        databaseSize: number;
        freeSpace: number;
        canRestore: boolean;
        pgVersion: string;
        timescaleVersion: string;
      }>('/backup/info'),
    getSchedule: () =>
      this.request<{
        type: BackupScheduleType;
        time: string;
        dayOfWeek: number;
        dayOfMonth: number;
        retentionCount: number;
        timezone: string;
      }>('/backup/schedule'),
    updateSchedule: (data: {
      type: BackupScheduleType;
      time: string;
      dayOfWeek: number;
      dayOfMonth: number;
      retentionCount: number;
    }) =>
      this.request<{ success: boolean }>('/backup/schedule', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  };
}

export const api = new ApiClient();
