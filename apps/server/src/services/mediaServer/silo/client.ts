/**
 * Silo Media Server Client
 *
 * Talks to a Silo server through its /api/v2 REST API, called with an API key as a bearer token.
 */

import {
  fetchJson,
  HttpClientError,
  isHttpStatus,
  jsonHeaders,
  type HttpRequestOptions,
} from '../../../utils/http.js';
import { createLogger } from '../../../utils/logger.js';
import { probeRefusal } from '../../../utils/ssrf.js';
import {
  NOT_NEEDED,
  cursorDate,
  type DownloadSourceDescription,
  type DownloadSourceRequest,
  type IMediaServerClient,
  type MediaLibrary,
  type MediaLibraryItem,
  type MediaProfile,
  type MediaServerConfig,
  type MediaSession,
  type MediaUser,
  type NotNeeded,
  type SyncCursor,
} from '../types.js';
import {
  parseSiloDeviceNames,
  parseSiloLibraries,
  parseSiloLibraryListing,
  parseSiloProfiles,
  parseSiloSession,
  parseSiloUsers,
  type SiloLibraryListing,
} from './parser.js';
import type {
  SiloCatalogItem,
  SiloDevice,
  SiloLibrary,
  SiloPage,
  SiloProfile,
  SiloServerIdentity,
  SiloSession,
  SiloSocketTicket,
  SiloSystemInfo,
  SiloUser,
} from './types.js';

const log = createLogger('silo-client');

const API_PATH = '/api/v2';
const TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 200;
const CONTENT_IDS_PER_READ = 200;
const STOP_REASON_MAX = 1024;
const DEVICE_NAMES_KEPT_MS = 10 * 60 * 1000;
const DEVICE_RETRY_MS = 60 * 1000;
const PROBE_SESSION_ID = '00000000-0000-4000-8000-000000000000';
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_WAIT_DEFAULT_MS = 1000;
const RATE_LIMIT_WAIT_MAX_MS = 10_000;
const RATE_LIMIT_WAIT_BUDGET_MS = 10_000;
/** A poster lookup holds one of the image proxy's fetch slots while it waits */
const POSTER_WAIT_BUDGET_MS = 2_000;
const NO_POSTER_KEPT_MS = 5 * 60 * 1000;

export const SILO_STOP_REFUSED = 'this Silo API key cannot stop streams';

const MISSING_SCOPES_MESSAGE =
  'This Silo API key lacks a scope Tracearr needs. Create a key with admin:monitor:read, admin:sessions:control and libraries:read. An unscoped admin key does not work; Tracearr needs a key with exactly those three scopes.';

/** The build and contract each server's system info last gave, by server URL */
const contracts = new Map<string, { version: string; digest: string }>();

function recordContract(url: string, info: SiloSystemInfo): void {
  const seen = contracts.get(url);
  if (!seen) {
    log.info(`Silo at ${url}: build ${info.server_version}, contract ${info.contract_digest}`);
  } else if (seen.version !== info.server_version || seen.digest !== info.contract_digest) {
    log.warn(
      `Silo at ${url} changed: build ${seen.version} to ${info.server_version}, ` +
        `contract ${seen.digest} to ${info.contract_digest}`
    );
  }
  contracts.set(url, { version: info.server_version, digest: info.contract_digest });
}

/**
 * Device names from each server's device list, by server URL. After a failed read the names
 * held stay in use, and the list is not read again before retryAt.
 */
const deviceNames = new Map<
  string,
  { names: Map<string, string>; readAt: number; retryAt: number }
>();

const POSTER_URL_MARGIN_MS = 10 * 60 * 1000;

// ponytail: one entry per movie, series and live session per Silo server, each kept about a day,
// swept only on a listing walk or on read; add a size cap or a periodic sweep if memory matters
/**
 * Signed poster URLs by server URL and content id, each until shortly before it expires, or null
 * for a while after the catalog listed no poster, since the image route is unauthenticated and
 * every lookup spends the key's rate budget
 */
const posterUrls = new Map<string, { url: string | null; expiresAt: number }>();

const posterKey = (serverUrl: string, contentId: string) =>
  `${serverUrl.replace(/\/$/, '')} ${contentId}`;

/** Remembers a signed poster URL for an item until ten minutes before its exp; anything but a root-relative /api/v2/ URL with exp is ignored */
export function rememberPosterUrl(
  serverUrl: string,
  contentId: string,
  posterUrl: string | null | undefined
): void {
  if (!posterUrl?.startsWith('/api/v2/')) return;
  const exp = Number(new URL(posterUrl, 'http://silo').searchParams.get('exp'));
  const expiresAt = exp * 1000 - POSTER_URL_MARGIN_MS;
  if (!(expiresAt > Date.now())) return;
  posterUrls.set(posterKey(serverUrl, contentId), { url: posterUrl, expiresAt });
}

function heldPosterUrl(serverUrl: string, contentId: string): string | null | undefined {
  const key = posterKey(serverUrl, contentId);
  const held = posterUrls.get(key);
  if (!held) return undefined;
  if (held.expiresAt > Date.now()) return held.url;
  posterUrls.delete(key);
  return undefined;
}

function sweepPosterUrls(): void {
  const now = Date.now();
  for (const [key, { expiresAt }] of posterUrls) {
    if (expiresAt <= now) posterUrls.delete(key);
  }
}

function rateLimitWaitMs(retryAfter: string | undefined): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const waitMs =
    Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : RATE_LIMIT_WAIT_DEFAULT_MS;
  return Math.min(waitMs, RATE_LIMIT_WAIT_MAX_MS);
}

/** Silo answers 429 once a key sends about 30 requests in a second, which a listing walk does */
async function fetchSilo<T>(
  url: string,
  options: HttpRequestOptions,
  waitBudgetMs = RATE_LIMIT_WAIT_BUDGET_MS
): Promise<T> {
  let waitedMs = 0;
  for (let retries = 0; ; retries++) {
    try {
      return await fetchJson<T>(url, { ...options, service: 'silo' });
    } catch (error) {
      if (!isHttpStatus(error, 429) || retries === RATE_LIMIT_RETRIES) throw error;
      const waitMs = rateLimitWaitMs(error.retryAfter);
      if (waitedMs + waitMs > waitBudgetMs) throw error;
      waitedMs += waitMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

type LibraryPage = { items: MediaLibraryItem[]; totalCount: number; rawCount: number };

function pageOf(
  items: MediaLibraryItem[],
  options: { offset?: number; limit?: number } | undefined
): LibraryPage {
  const offset = options?.offset ?? 0;
  const page = items.slice(offset, offset + (options?.limit ?? PAGE_LIMIT));
  return { items: page, totalCount: items.length, rawCount: page.length };
}

export class SiloClient implements IMediaServerClient {
  public readonly serverType = 'silo' as const;
  readonly url: string;
  private readonly token: string;
  /**
   * Each library's parsed listing, by library id, or library id and date for what was added
   * since. A sync builds its own client, so a listing lives one sync, and every parsed item of
   * one library is held at once.
   */
  private readonly listings = new Map<string, Promise<SiloLibraryListing>>();

  constructor(config: MediaServerConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.token = config.token;
  }

  private request<T>(
    path: string,
    init: HttpRequestOptions = {},
    waitBudgetMs?: number
  ): Promise<T> {
    return fetchSilo<T>(
      `${this.url}${API_PATH}${path}`,
      { ...init, headers: jsonHeaders(this.token) },
      waitBudgetMs
    );
  }

  /** Silo answers these without a key */
  private publicRequest<T>(path: string): Promise<T> {
    return fetchSilo<T>(`${this.url}${API_PATH}${path}`, {
      headers: jsonHeaders(),
      timeout: TIMEOUT_MS,
    });
  }

  /** Every page of a listing */
  private async listAll<T>(path: string, timeout?: number): Promise<T[]> {
    const items: T[] = [];
    const separator = path.includes('?') ? '&' : '?';
    let cursor: string | undefined;
    do {
      const page: SiloPage<T> = await this.request<SiloPage<T>>(
        `${path}${separator}limit=${PAGE_LIMIT}` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
        { timeout }
      );
      items.push(...page.items);
      cursor = page.page?.has_more ? page.page.next_cursor : undefined;
    } while (cursor);
    return items;
  }

  async systemInfo(): Promise<SiloSystemInfo> {
    const info = await this.publicRequest<SiloSystemInfo>('/system/info');
    recordContract(this.url, info);
    return info;
  }

  async getSessions(sessionKey?: string): Promise<MediaSession[]> {
    const rows = (await this.listAll<SiloSession>('/admin/sessions', TIMEOUT_MS)).filter(
      (row) => sessionKey === undefined || row.session_id === sessionKey
    );
    for (const row of rows) {
      if (row.media_item_id) rememberPosterUrl(this.url, row.media_item_id, row.poster_url);
    }
    const names = await this.deviceNames(rows);
    return rows.map((row) =>
      parseSiloSession(row, row.device_id ? names.get(row.device_id) : undefined)
    );
  }

  /**
   * Read again after ten minutes, or sooner when a session names a device the list did not, but
   * not within a minute of a failed read
   */
  private async deviceNames(rows: SiloSession[]): Promise<Map<string, string>> {
    const held = deviceNames.get(this.url);
    const wanted = rows.flatMap((row) => (row.device_id ? [row.device_id] : []));
    const now = Date.now();
    if (
      wanted.length === 0 ||
      (held &&
        (now < held.retryAt ||
          (now - held.readAt < DEVICE_NAMES_KEPT_MS && wanted.every((id) => held.names.has(id)))))
    ) {
      return held?.names ?? new Map();
    }
    try {
      const names = parseSiloDeviceNames(await this.listAll<SiloDevice>('/admin/devices'));
      deviceNames.set(this.url, { names, readAt: now, retryAt: 0 });
      return names;
    } catch (error) {
      log.warn('Silo devices could not be read, naming players by the names last read', {
        err: error,
      });
      const names = held?.names ?? new Map<string, string>();
      deviceNames.set(this.url, {
        names,
        readAt: held?.readAt ?? 0,
        retryAt: now + DEVICE_RETRY_MS,
      });
      return names;
    }
  }

  async getUsers(): Promise<MediaUser[]> {
    return parseSiloUsers(await this.listAll<SiloUser>('/admin/users'));
  }

  async getAccountProfiles(accountExternalId: string): Promise<MediaProfile[]> {
    // Silo refuses query parameters the endpoint does not declare, and this one declares no paging
    const { items } = await this.request<SiloPage<SiloProfile>>(
      `/admin/users/${encodeURIComponent(accountExternalId)}/profiles`
    );
    return parseSiloProfiles(items);
  }

  /** include_hidden, so a library the key's own profile hid is still synced */
  async getLibraries(): Promise<MediaLibrary[]> {
    const { items } = await this.request<SiloPage<SiloLibrary>>(
      '/user/libraries?include_hidden=true'
    );
    return parseSiloLibraries(items);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.systemInfo();
      await this.request<SiloPage<SiloSession>>('/admin/sessions?limit=1', {
        timeout: TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getServerIdentity(): Promise<string | null> {
    return (await this.publicRequest<SiloServerIdentity>('/system/identity')).server_id;
  }

  async getSoftwareVersion(): Promise<string | null> {
    return (await this.systemInfo()).server_version;
  }

  async describeDownloadSource(request: DownloadSourceRequest): Promise<DownloadSourceDescription> {
    return {
      version: null,
      delivered: null,
      device: {
        deviceId: request.deviceId,
        playerName: request.device,
        product: request.app,
        platform: null,
      },
      ipAddress: null,
    };
  }

  async terminateSession(sessionId: string, reason?: string): Promise<boolean> {
    try {
      await this.request<unknown>(`/admin/sessions/${encodeURIComponent(sessionId)}/terminate`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason: reason.slice(0, STOP_REASON_MAX) } : {}),
        timeout: TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      if (isHttpStatus(error, 403)) throw new Error(SILO_STOP_REFUSED);
      if (isHttpStatus(error, 404)) throw new Error('Session not found (may have already ended)');
      throw new Error(
        `Failed to stop the session: ${
          error instanceof HttpClientError ? error.statusCode : errorMessage(error, 'unknown error')
        }`
      );
    }
  }

  private listing(libraryId: string, addedAfter?: Date): Promise<SiloLibraryListing> {
    const since = addedAfter?.toISOString();
    return this.listings.getOrInsertComputed(
      since ? `${libraryId}:${since}` : libraryId,
      async () => {
        const catalog = await this.listAll<SiloCatalogItem>(
          `/admin/catalog/items?library_id=${encodeURIComponent(libraryId)}` +
            (since ? `&added_after=${encodeURIComponent(since)}` : '')
        );
        sweepPosterUrls();
        for (const item of catalog) {
          const contentId = item.type === 'episode' ? item.series_id : item.content_id;
          if (contentId) rememberPosterUrl(this.url, contentId, item.poster_url);
        }
        return parseSiloLibraryListing(catalog, libraryId);
      }
    );
  }

  /** A signed poster URL for an item, or null when Silo lists no poster for it on its own API */
  async getPosterUrl(contentId: string): Promise<string | null> {
    const held = heldPosterUrl(this.url, contentId);
    if (held !== undefined) return held;
    const { items } = await this.request<SiloPage<SiloCatalogItem>>(
      `/admin/catalog/items?content_ids=${encodeURIComponent(contentId)}`,
      { timeout: TIMEOUT_MS },
      POSTER_WAIT_BUDGET_MS
    );
    const posterUrl = items.find((item) => item.content_id === contentId)?.poster_url;
    if (!posterUrl?.startsWith('/api/v2/')) {
      posterUrls.set(posterKey(this.url, contentId), {
        url: null,
        expiresAt: Date.now() + NO_POSTER_KEPT_MS,
      });
      return null;
    }
    rememberPosterUrl(this.url, contentId, posterUrl);
    return posterUrl;
  }

  async getLibraryItems(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<LibraryPage> {
    return pageOf((await this.listing(libraryId)).items, options);
  }

  async getLibraryLeaves(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<LibraryPage> {
    return pageOf((await this.listing(libraryId)).episodes, options);
  }

  async getLibrarySeasons(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<LibraryPage> {
    return pageOf((await this.listing(libraryId)).seasons, options);
  }

  async getLibraryItemsSince(
    libraryId: string,
    since: SyncCursor
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; feed: NotNeeded }> {
    const { items } = await this.listing(libraryId, cursorDate(since));
    return { items, totalCount: items.length, feed: NOT_NEEDED };
  }

  async getLibraryLeavesSince(
    libraryId: string,
    since: SyncCursor
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const { episodes } = await this.listing(libraryId, cursorDate(since));
    return { items: episodes, totalCount: episodes.length };
  }

  /**
   * A season is dated by its earliest episode, which only the whole listing knows: one built from
   * the episodes added since would move an older season's date forward
   */
  async getLibrarySeasonsSince(
    libraryId: string,
    since: SyncCursor
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const after = cursorDate(since);
    const { seasons } = await this.listing(libraryId);
    const added = seasons.filter((season) => season.addedAt >= after);
    return { items: added, totalCount: added.length };
  }

  // Silo lists changes by date
  async getLibraryRevision(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  // Silo has no music
  async getLibraryAlbums(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  // Silo has no music
  async getLibraryAlbumsSince(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  // The catalog lists only files that are present
  async checkFilesExist(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  /**
   * Movies, series and episodes are looked up by id. A season is no catalog item, so it is never
   * found, which is right for one a complete listing of the library left out.
   */
  async findExistingRatingKeys(
    ratingKeys: string[],
    library: { id: string; type: string }
  ): Promise<Set<string>> {
    const ids = ratingKeys.filter((key) => !key.includes('/season/'));
    const found = new Set<string>();
    for (let start = 0; start < ids.length; start += CONTENT_IDS_PER_READ) {
      const query = ids
        .slice(start, start + CONTENT_IDS_PER_READ)
        .map((id) => `content_ids=${encodeURIComponent(id)}`)
        .join('&');
      for (const item of await this.listAll<SiloCatalogItem>(`/admin/catalog/items?${query}`)) {
        rememberPosterUrl(this.url, item.content_id, item.poster_url);
        if (item.library_ids.includes(library.id)) found.add(item.content_id);
      }
    }
    return found;
  }

  async getRequests(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  async getRequestPosterPath(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
    MISSING_SCOPES: 'MISSING_SCOPES',
  } as const;

  /**
   * The system info needs no key, so an unreachable server is told apart from a rejected key.
   * A key without admin:sessions:control or libraries:read still reads sessions and gets a socket
   * ticket, so the library list and a stop of a session that does not exist check those two: the
   * stop answers 404 with the scope and 403 without it.
   */
  static async verifyServerAdmin(
    token: string,
    serverUrl: string
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    const url = serverUrl.replace(/\/$/, '');
    const fail = (code: string, message: string) => ({ success: false as const, code, message });

    const refusal = probeRefusal(url);
    if (refusal) return fail(SiloClient.AdminVerifyError.CONNECTION_FAILED, refusal);

    let info: SiloSystemInfo;
    try {
      info = await fetchSilo<SiloSystemInfo>(`${url}${API_PATH}/system/info`, {
        headers: jsonHeaders(),
        timeout: TIMEOUT_MS,
      });
    } catch (error) {
      return fail(
        SiloClient.AdminVerifyError.CONNECTION_FAILED,
        `Cannot reach Silo server at ${url}. ${errorMessage(error, 'Unable to connect to server')}`
      );
    }
    if (info.api_major !== 2) {
      return fail(
        SiloClient.AdminVerifyError.CONNECTION_FAILED,
        `${url} does not answer as a Silo server with API version 2.`
      );
    }
    recordContract(url, info);

    const client = new SiloClient({ url, token });
    const timeout = TIMEOUT_MS;
    try {
      await client.request<SiloPage<SiloSession>>('/admin/sessions?limit=1', { timeout });
      await client.request<SiloSocketTicket>('/events/ws-ticket', { method: 'POST', timeout });
      await client.request<SiloPage<SiloLibrary>>('/user/libraries', { timeout });
      await client
        .request<unknown>(`/admin/sessions/${PROBE_SESSION_ID}/terminate`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Tracearr key check' }),
          timeout,
        })
        .catch((error: unknown) => {
          if (!isHttpStatus(error, 404)) throw error;
        });
      return { success: true };
    } catch (error) {
      if (isHttpStatus(error, 401)) {
        return fail(
          SiloClient.AdminVerifyError.INVALID_KEY,
          'Silo rejected this API key (it may be invalid, revoked or expired).'
        );
      }
      if (isHttpStatus(error, 403)) {
        return fail(SiloClient.AdminVerifyError.MISSING_SCOPES, MISSING_SCOPES_MESSAGE);
      }
      return fail(
        SiloClient.AdminVerifyError.CONNECTION_FAILED,
        `Could not verify the API key on Silo server at ${url}. ${errorMessage(error, 'Unable to verify the API key')}`
      );
    }
  }
}
