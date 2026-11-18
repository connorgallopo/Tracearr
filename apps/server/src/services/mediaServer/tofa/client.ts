/**
 * tofa Media Server Client
 *
 * Implements IMediaServerClient for tofa servers through their REST API, called with an
 * API key as a bearer token.
 */

import { SESSION_LIMITS, assertNever } from '@tracearr/shared';
import {
  fetchJson,
  isHttpStatus,
  jsonHeaders,
  type HttpRequestOptions,
} from '../../../utils/http.js';
import { createLogger } from '../../../utils/logger.js';
import { assertSafeProbeUrl, probeRefusal } from '../../../utils/ssrf.js';
import {
  FullSyncRequiredError,
  INCREMENTAL_CAP_RATIO,
  NOT_NEEDED,
  type IMediaServerClient,
  type LibraryChangeFeed,
  type MediaSession,
  type MediaUser,
  type MediaLibrary,
  type MediaLibraryItem,
  type MediaServerConfig,
  type DownloadSourceDescription,
  type DownloadSourceRequest,
  type NotNeeded,
  type SyncCursor,
} from '../types.js';
import { lookupTofaMedia } from './mediaLookup.js';
import {
  parseKeyScopes,
  parseLibraries,
  parseTofaDownloadSource,
  parseTofaLibraryItem,
  parseTofaLiveSession,
  parseTofaMedia,
  parseTofaSession,
  parseTofaShowChildren,
  parseAccountLinks,
  parseDiscoveryPoster,
  parseUsers,
  type TofaLinkedAccount,
} from './parser.js';
import type {
  TofaApiKey,
  TofaCloudUser,
  TofaDiscoveryDetail,
  TofaDownload,
  TofaDownloads,
  TofaKeyScopes,
  TofaLibrary,
  TofaLibraryFiles,
  TofaLiveAdminNow,
  TofaLiveNowPlayingSession,
  TofaAccountLink,
  TofaMediaChanges,
  TofaMedia,
  TofaMediaDetail,
  TofaMediaFile,
  TofaMediaPage,
  TofaMetrics,
  TofaNowPlaying,
  TofaNowPlayingSession,
  TofaPlaybackSession,
  TofaProfile,
  TofaRequest,
  TofaSystemInfo,
  TofaUpdateStatus,
  TofaUser,
  TofaWatchHistory,
} from './types.js';

const log = createLogger('tofa-client');

const API_PATH = '/api/v1';
const CONNECT_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;
const SESSIONS_TIMEOUT_MS = 10_000;
const LIVE_VIEWERS_TIMEOUT_MS = 5_000;
const REQUEST_POSTER_TIMEOUT_MS = 5_000;
// /media serves at most 200 a page, /media/files 1000, and /media/batch reads 50 at a time
const MEDIA_PAGE_LIMIT = 200;
const FILES_PAGE_LIMIT = 1000;
const BATCH_SIZE = 50;
// A show's detail is about 350 KB, so a full batch can be 12 MB; this still reads one at 1 Mbit/s
const MEDIA_BATCH_TIMEOUT_MS = 120_000;
// tofa's default is about 500 changes, past which it asks for a full sync; its spec names no maximum
const CHANGES_LIMIT = 10_000;
// A parsed episode holds about 1.1 KB, so this keeps a sync's held shows near 55 MB; the episode
// listing reads a show past it again, as it reads one the library listing did not hold
const HELD_EPISODES_LIMIT = 50_000;
const DOWNLOADS_PAGE_LIMIT = 100;

export const TOFA_STOP_REFUSED = 'this tofa API key cannot stop streams';

const apiUrl = (serverUrl: string, path: string) =>
  `${serverUrl.replace(/\/$/, '')}${API_PATH}${path}`;

/**
 * The viewers with no playback session each server's now-playing last listed, by server URL. They
 * stand in while now-playing does not answer, so its outage does not stop them, for no longer
 * than the poller keeps a session it does not see.
 */
const lastLiveSessions = new Map<string, { live: TofaLiveNowPlayingSession[]; readAt: number }>();
const LIVE_SESSIONS_KEPT_MS = SESSION_LIMITS.STALE_SESSION_TIMEOUT_SECONDS * 1000;

/**
 * The downloads each server's download list last named, with their files, by server URL, file and
 * device. The poll records each download right after listing it, so describing one reads nothing
 * again.
 */
const listedDownloads = new Map<
  string,
  { download: TofaDownload; file: TofaMediaFile | undefined; expiresAt: number }
>();
const LISTED_DOWNLOADS_KEPT_MS = 5 * 60 * 1000;

const listedDownloadKey = (url: string, fileId: string | null, deviceId: string | null) =>
  `${url}:${fileId}:${deviceId}`;

/**
 * The sessions each server's last read left without their media, with why, by server URL. A
 * session is logged when it goes undescribed, not every poll. A channel play can go back and forth,
 * so its return is logged only at debug.
 */
const undescribedSessions = new Map<string, Map<string, string>>();

function undescribedReason(
  row: TofaPlaybackSession,
  playing: TofaNowPlayingSession | undefined,
  media: Map<string, TofaMedia>
): string {
  if (!playing) return 'now-playing does not list it';
  if (!row.media_id) return 'it names no media';
  if (!media.has(row.media_id)) return 'the media lookup did not return its media';
  return 'its show does not list its file';
}

function logUndescribedSessions(
  url: string,
  kept: Set<string>,
  undescribed: [string, string][]
): void {
  const previous = undescribedSessions.get(url) ?? new Map<string, string>();
  const current = new Map(undescribed);
  for (const [sessionId, reason] of current) {
    if (previous.get(sessionId) !== reason) {
      log.info(`session ${sessionId} read without its media: ${reason}`);
    }
  }
  for (const sessionId of previous.keys()) {
    if (kept.has(sessionId) && !current.has(sessionId)) {
      log.debug(`session ${sessionId} read with its media again`);
    }
  }
  undescribedSessions.set(url, current);
}

type LibraryPage = { items: MediaLibraryItem[]; totalCount: number; rawCount?: number };

/** A library's episodes that have a file, grouped by show, in the order getLibraryLeaves pages them */
type EpisodeIndex = { showId: string; episodeIds: string[] }[];

type ShowChildren = ReturnType<typeof parseTofaShowChildren>;

function cursorRevision(cursor: SyncCursor): number {
  switch (cursor.kind) {
    case 'revision':
      return cursor.since;
    case 'date':
      throw new Error('tofa lists library changes by revision, not by date');
    default:
      return assertNever(cursor);
  }
}

/**
 * tofa keeps listing a session after its player is gone, and a player that reconnects opens a
 * new one, so of a device's sessions on one file only the newest is playing. A session with
 * no device id is never folded into another.
 */
function newestPerDeviceAndFile(rows: TofaPlaybackSession[]): TofaPlaybackSession[] {
  const newest = new Map<string, TofaPlaybackSession>();
  for (const row of rows) {
    const key = `${row.user_id}:${row.device_id ?? row.session_id}:${row.media_file_id}`;
    const kept = newest.get(key);
    if (!kept || Date.parse(row.created_at) > Date.parse(kept.created_at)) newest.set(key, row);
  }
  return [...newest.values()];
}

export class TofaClient implements IMediaServerClient {
  public readonly serverType = 'tofa' as const;

  readonly url: string;
  private readonly token: string;
  /** Read once per library; a sync builds its own client, so an index lives as long as one sync */
  private readonly episodeIndexes = new Map<string, Promise<EpisodeIndex>>();
  /**
   * The seasons and episodes of each show the library listing read, by show id, so the episode
   * listing of the same sync reads no show again. A show leaves once its last episode is listed.
   */
  private readonly showChildren = new Map<string, ShowChildren>();
  private heldEpisodes = 0;
  /** Each library's media count as its listing last gave it; a sync reads the count first */
  private readonly libraryTotals = new Map<string, number>();

  constructor(config: MediaServerConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.token = config.token;
  }

  private request<T>(path: string, init: HttpRequestOptions = {}): Promise<T> {
    return fetchJson<T>(`${this.url}${API_PATH}${path}`, {
      ...init,
      headers: jsonHeaders(this.token),
      service: 'tofa',
    });
  }

  systemInfo(): Promise<TofaSystemInfo> {
    return this.request<TofaSystemInfo>('/system/info');
  }

  /**
   * The session list merged with now-playing, which adds playback health and names the
   * channel of a live TV play. The channel itself comes from
   * the live viewers, read only while a channel is playing. A viewer with no playback session
   * is listed under now-playing live_sessions. Only the session list is needed: when another
   * read fails, its sessions are listed without what it adds.
   */
  async getSessions(): Promise<MediaSession[]> {
    const [listedRows, nowPlaying] = await Promise.all([
      this.request<TofaPlaybackSession[]>('/system/playback/sessions', {
        timeout: SESSIONS_TIMEOUT_MS,
      }),
      this.readNowPlaying(),
    ]);
    const rows = newestPerDeviceAndFile(listedRows);
    const nowPlayingById = new Map(nowPlaying.sessions.map((s) => [s.session_id, s]));
    const [viewers, media] = await Promise.all([
      nowPlaying.sessions.some((s) => s.live_channel_id)
        ? this.request<TofaLiveAdminNow>('/live/admin/now', { timeout: LIVE_VIEWERS_TIMEOUT_MS })
            .then((now) => now.sessions)
            .catch((error: unknown) => {
              log.warn('tofa live viewers could not be read, listing channels without them', {
                err: error,
              });
              return [];
            })
        : [],
      lookupTofaMedia(
        this,
        rows.flatMap((row) =>
          row.media_id ? [{ mediaId: row.media_id, fileId: row.media_file_id }] : []
        )
      ),
    ]);
    // Every listed id, so a set-aside session is not read back in as a live viewer
    const listed = new Set(listedRows.map((row) => row.session_id));
    const sessions = rows.map((row) => {
      const playing = nowPlayingById.get(row.session_id);
      return parseTofaSession(
        row,
        playing,
        row.media_id ? media.get(row.media_id) : undefined,
        viewers.find(
          (viewer) =>
            viewer.user_id === row.user_id && viewer.channel_id === playing?.live_channel_id
        )
      );
    });
    logUndescribedSessions(
      this.url,
      new Set(rows.map((row) => row.session_id)),
      rows.flatMap((row, i) =>
        sessions[i]?.mediaId === ''
          ? [[row.session_id, undescribedReason(row, nowPlayingById.get(row.session_id), media)]]
          : []
      )
    );
    return [
      ...sessions,
      ...(nowPlaying.live_sessions ?? [])
        .filter((live) => !listed.has(live.session_id))
        .map(parseTofaLiveSession),
    ];
  }

  private async readNowPlaying(): Promise<TofaNowPlaying> {
    try {
      const nowPlaying = await this.request<TofaNowPlaying>('/system/activity/now-playing', {
        timeout: SESSIONS_TIMEOUT_MS,
      });
      lastLiveSessions.set(this.url, {
        live: nowPlaying.live_sessions ?? [],
        readAt: Date.now(),
      });
      return nowPlaying;
    } catch (error) {
      log.warn('tofa now-playing could not be read, listing sessions without it', { err: error });
      const last = lastLiveSessions.get(this.url);
      return {
        sessions: [],
        live_sessions: last && Date.now() - last.readAt <= LIVE_SESSIONS_KEPT_MS ? last.live : [],
      };
    }
  }

  getMediaBatch(mediaIds: string[], timeout: number): Promise<TofaMediaDetail[]> {
    return this.request<TofaMediaDetail[]>('/media/batch', {
      method: 'POST',
      body: JSON.stringify({ ids: mediaIds }),
      timeout,
    });
  }

  async getUsers(): Promise<MediaUser[]> {
    const [users, cloudUsers, profiles] = await Promise.all([
      this.request<TofaUser[]>('/users'),
      this.request<TofaCloudUser[]>('/cloud/users'),
      this.request<TofaProfile[] | null>('/profiles').catch((error: unknown) => {
        log.warn('tofa profiles could not be read, leaving user pictures as they are', {
          err: error,
        });
        return null;
      }),
    ]);
    return parseUsers(users, cloudUsers, profiles);
  }

  async getAccountLinks(): Promise<TofaLinkedAccount[]> {
    return parseAccountLinks(await this.request<TofaAccountLink[]>('/import/accounts/all'));
  }

  async getLibraries(): Promise<MediaLibrary[]> {
    return parseLibraries(await this.request<TofaLibrary[]>('/libraries'));
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request<TofaSystemInfo>('/system/info', { timeout: CONNECT_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async getServerIdentity(): Promise<string | null> {
    return (await this.systemInfo()).server_id ?? null;
  }

  async getSoftwareVersion(): Promise<string | null> {
    return (await this.systemInfo()).version;
  }

  getMetrics(): Promise<TofaMetrics> {
    return this.request<TofaMetrics>('/system/metrics');
  }

  /** The completion percent at which tofa itself counts a play as watched. */
  async getWatchedRulePercent(): Promise<number | null> {
    return (await this.systemInfo()).watched_rule?.percent ?? null;
  }

  async getKeyScopes(): Promise<TofaKeyScopes> {
    return parseKeyScopes(await this.request<TofaApiKey[]>('/auth/api-keys'), this.token);
  }

  /** tofa publishes no release feed; its own update check names the release it found. */
  async getUpdateVersion(): Promise<string | null> {
    const status = await this.request<TofaUpdateStatus>('/updates/status');
    return status.state === 'up_to_date' ? null : (status.version ?? null);
  }

  /**
   * The download is the one the download list just named, or is found among the user's by its
   * file and device. A failed lookup leaves the file's fields null and keeps the device the
   * request named.
   */
  async describeDownloadSource(request: DownloadSourceRequest): Promise<DownloadSourceDescription> {
    const listed = listedDownloads.get(
      listedDownloadKey(this.url, request.partId, request.deviceId)
    );
    const download =
      listed?.download ??
      (request.userId
        ? await this.request<TofaDownloads>(
            `/system/downloads?user_id=${encodeURIComponent(request.userId)}`
          ).then(
            ({ items }) =>
              items.find(
                (d) => d.media_file_id === request.partId && d.device_id === request.deviceId
              ),
            () => undefined
          )
        : undefined);
    const file =
      listed?.file ??
      (download
        ? await this.getMediaBatch([download.media_id], MEDIA_BATCH_TIMEOUT_MS).then(
            ([detail]) => detail?.files.find((f) => f.id === download.media_file_id),
            () => undefined
          )
        : undefined);
    return parseTofaDownloadSource(request, download, file);
  }

  /** A page of finished plays, newest first, that started before the given time when one is given */
  getWatchHistoryPage(before: string | null, limit: number): Promise<TofaWatchHistory> {
    return this.request<TofaWatchHistory>(
      `/system/watch-history?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`
    );
  }

  /**
   * Offline downloads created after the given time, newest first, each with the media it holds.
   * A failed media read leaves the media out.
   */
  async getDownloadsAfter(
    after: Date
  ): Promise<{ download: TofaDownload; media: TofaMedia | undefined }[]> {
    const downloads: TofaDownload[] = [];
    let cursor = '';
    for (;;) {
      const page = await this.request<TofaDownloads>(
        `/system/downloads?limit=${DOWNLOADS_PAGE_LIMIT}${cursor}`
      );
      const newer = page.items.filter((d) => new Date(d.created_at) > after);
      downloads.push(...newer);
      const oldest = page.items.at(-1);
      if (!page.has_more || !oldest || newer.length < page.items.length) break;
      cursor = `&before=${encodeURIComponent(oldest.created_at)}&before_id=${oldest.id}`;
    }

    const fileIds = new Set(downloads.map((d) => d.media_file_id));
    const read = await this.readMedia([...new Set(downloads.map((d) => d.media_id))], (detail) => [
      {
        id: detail.id,
        media: parseTofaMedia(detail),
        files: detail.files.filter((file) => fileIds.has(file.id)),
      },
    ]).catch((error: unknown) => {
      log.warn('tofa media of new downloads could not be read, recording them without it', {
        err: error,
      });
      return [];
    });
    const byId = new Map(read.map((media) => [media.id, media]));

    const now = Date.now();
    for (const [key, entry] of listedDownloads) {
      if (entry.expiresAt <= now) listedDownloads.delete(key);
    }
    return downloads.map((download) => {
      const media = byId.get(download.media_id);
      listedDownloads.set(listedDownloadKey(this.url, download.media_file_id, download.device_id), {
        download,
        file: media?.files.find((file) => file.id === download.media_file_id),
        expiresAt: now + LISTED_DOWNLOADS_KEPT_MS,
      });
      return { download, media: media?.media };
    });
  }

  /** Every request on the server; tofa pages none of them */
  async getRequests(): Promise<TofaRequest[]> {
    return (await this.request<{ requests: TofaRequest[] }>('/requests')).requests;
  }

  /** The poster tofa serves from its own image cache for a title, held in its library or not */
  async getRequestPosterPath(mediaType: 'movie' | 'tv', tmdbId: number): Promise<string | null> {
    return parseDiscoveryPoster(
      await this.request<TofaDiscoveryDetail>(
        `/discovery/detail/${mediaType}/${tmdbId}?local_images=true`,
        { timeout: REQUEST_POSTER_TIMEOUT_MS }
      )
    );
  }

  async terminateSession(sessionId: string, reason?: string): Promise<boolean> {
    const response = await fetch(
      `${this.url}${API_PATH}/system/playback/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'DELETE',
        headers: jsonHeaders(this.token),
        body: JSON.stringify({ message: reason ?? null }),
        signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(TOFA_STOP_REFUSED);
      }
      if (response.status === 404) {
        throw new Error('Session not found (may have already ended)');
      }
      throw new Error(`Failed to stop the session: ${response.status} ${response.statusText}`);
    }
    return true;
  }

  async getLibraryItems(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<LibraryPage> {
    const { ids, total } = await this.listMedia(
      libraryId,
      options?.offset ?? 0,
      options?.limit ?? MEDIA_PAGE_LIMIT
    );
    const items = await this.readMedia(ids, (detail) => {
      // A held show is not parsed again: the sync's count read lists the first show before its
      // listing does, and a retried page lists its shows twice
      if (this.heldEpisodes < HELD_EPISODES_LIMIT && !this.showChildren.has(detail.id)) {
        const children = parseTofaShowChildren(detail);
        if (children.episodes.length > 0) this.holdShow(detail.id, children);
      }
      return [parseTofaLibraryItem(detail)];
    });
    return { items, totalCount: total, rawCount: ids.length };
  }

  /**
   * Movies and shows are looked up by id. An episode or season id is no media id and is never
   * found, which is right for one a complete listing of the library left out: it has no file left.
   */
  async findExistingRatingKeys(
    ratingKeys: string[],
    library: { id: string }
  ): Promise<Set<string>> {
    return new Set(
      await this.readMedia(ratingKeys, (detail) =>
        detail.library_id === library.id ? [detail.id] : []
      )
    );
  }

  /**
   * Episodes with a file and the seasons holding them, paged over the library's episodes. A
   * show's seasons come with the page that holds its first episode. A show the library listing
   * held is not read again.
   */
  async getLibraryLeaves(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<LibraryPage> {
    const offset = options?.offset ?? 0;
    const end = offset + (options?.limit ?? MEDIA_PAGE_LIMIT);
    const index = await this.episodeIndex(libraryId);

    const pageShows: string[] = [];
    const startingShows = new Set<string>();
    const endingShows = new Set<string>();
    const wanted = new Set<string>();
    let position = 0;
    for (const { showId, episodeIds } of index) {
      if (position >= end) break;
      if (position + episodeIds.length > offset) {
        pageShows.push(showId);
        if (position >= offset) startingShows.add(showId);
        if (position + episodeIds.length <= end) endingShows.add(showId);
        for (const id of episodeIds.slice(Math.max(offset - position, 0), end - position)) {
          wanted.add(id);
        }
      }
      position += episodeIds.length;
    }

    const read = await this.readMedia(
      pageShows.filter((showId) => !this.showChildren.has(showId)),
      (show) => [{ id: show.id, children: parseTofaShowChildren(show) }]
    );
    for (const { id, children } of read) this.holdShow(id, children);
    const items = pageShows.flatMap((showId) => {
      const children = this.showChildren.get(showId);
      if (!children) return [];
      if (endingShows.has(showId)) {
        this.showChildren.delete(showId);
        this.heldEpisodes -= children.episodes.length;
      }
      return [
        ...(startingShows.has(showId) ? children.seasons : []),
        ...children.episodes.filter((episode) => wanted.has(episode.ratingKey)),
      ];
    });
    return {
      items,
      totalCount: index.reduce((sum, { episodeIds }) => sum + episodeIds.length, 0),
      rawCount: wanted.size,
    };
  }

  private holdShow(showId: string, children: ShowChildren): void {
    this.showChildren.set(showId, children);
    this.heldEpisodes += children.episodes.length;
  }

  /**
   * What changed in a library after a revision: movies, and changed shows whole, with their
   * seasons and episodes. A later change to the same media replaces an earlier one. A delete
   * names no library when the media is already gone, so it counts here.
   */
  async getLibraryItemsSince(
    libraryId: string,
    since: SyncCursor
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; feed: LibraryChangeFeed }> {
    const revision = cursorRevision(since);
    const changes = await this.request<TofaMediaChanges>(
      `/media/changes?since_revision=${revision}&limit=${CHANGES_LIMIT}`
    );
    if (changes.requires_full_sync) {
      throw new FullSyncRequiredError(
        `tofa no longer holds every library change since revision ${revision}`
      );
    }
    const latest = new Map(
      changes.changes
        .filter((change) => (change.library_id ?? libraryId) === libraryId)
        .toSorted((a, b) => a.revision - b.revision)
        .map((change) => [change.media_id, change.change_kind])
    );
    const upserted = [...latest].flatMap(([id, kind]) => (kind === 'upsert' ? [id] : []));
    // The sync falls back to a full scan past this many changes anyway, so none is read first
    if (upserted.length > 0) {
      const total =
        this.libraryTotals.get(libraryId) ?? (await this.listMedia(libraryId, 0, 1)).total;
      const cap = Math.floor(total * INCREMENTAL_CAP_RATIO);
      if (cap > 0 && upserted.length > cap) {
        throw new FullSyncRequiredError(
          `${upserted.length} of ${total} media changed since revision ${revision}`
        );
      }
    }
    const changed = await this.readMedia(upserted, (detail) => {
      if (detail.library_id !== libraryId) return [];
      const { seasons, episodes } = parseTofaShowChildren(detail);
      return [{ id: detail.id, items: [parseTofaLibraryItem(detail), ...seasons, ...episodes] }];
    });
    return {
      items: changed.flatMap((media) => media.items),
      totalCount: changed.length,
      feed: {
        deletedIds: [...latest].flatMap(([id, kind]) => (kind === 'delete' ? [id] : [])),
        wholeIds: changed.map((media) => media.id),
        revision: changes.latest_revision,
      },
    };
  }

  async getLibraryRevision(): Promise<number> {
    return (await this.request<TofaMediaChanges>('/media/changes')).latest_revision;
  }

  // A changed show's seasons and episodes come with it from getLibraryItemsSince
  async getLibraryLeavesSince(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  // Seasons arrive with getLibraryLeaves and getLibraryItemsSince
  async getLibrarySeasons(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  // Seasons arrive with getLibraryLeaves and getLibraryItemsSince
  async getLibrarySeasonsSince(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  // tofa has no music
  async getLibraryAlbums(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  // tofa has no music
  async getLibraryAlbumsSince(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  /**
   * Whether each file is on disk, as tofa marks it available, for movies and episodes. An item's
   * files all sit in its library, so libraries after the one that held the last key are not read.
   */
  async checkFilesExist(ratingKeys: string[]): Promise<Map<string, Map<string, boolean>>> {
    const wanted = new Set(ratingKeys);
    const existence = new Map<string, Map<string, boolean>>();
    for (const library of await this.request<TofaLibrary[]>('/libraries')) {
      if (existence.size === wanted.size) break;
      for (const file of await this.libraryFiles(library.id)) {
        const key = file.episode_id ?? file.media_id;
        if (!wanted.has(key)) continue;
        existence.getOrInsertComputed(key, () => new Map()).set(file.media_file_id, file.available);
      }
    }
    return existence;
  }

  /**
   * The ids of a library's media at [offset, offset + limit), in tofa's title order. tofa pages
   * by page number, so the page size must divide the offset.
   */
  private async listMedia(
    libraryId: string,
    offset: number,
    limit: number
  ): Promise<{ ids: string[]; total: number }> {
    let perPage = Math.min(limit, MEDIA_PAGE_LIMIT);
    while (offset % perPage !== 0 || limit % perPage !== 0) perPage--;

    const ids: string[] = [];
    let total = 0;
    for (let page = offset / perPage + 1; ids.length < limit; page++) {
      const listing = await this.request<TofaMediaPage>(
        `/media?library_id=${encodeURIComponent(libraryId)}&page=${page}&per_page=${perPage}`
      );
      ids.push(...listing.items.map((item) => item.id));
      total = listing.total;
      this.libraryTotals.set(libraryId, total);
      if (listing.items.length < perPage) break;
    }
    return { ids, total };
  }

  /**
   * The given media, each batch parsed as it arrives so only one batch of details is held at a
   * time; an id tofa does not know as media is left out.
   */
  private async readMedia<T>(ids: string[], parse: (detail: TofaMediaDetail) => T[]): Promise<T[]> {
    const parsed: T[] = [];
    for (let start = 0; start < ids.length; start += BATCH_SIZE) {
      const batch = ids.slice(start, start + BATCH_SIZE);
      for (const detail of await this.getMediaBatch(batch, MEDIA_BATCH_TIMEOUT_MS)) {
        parsed.push(...parse(detail));
      }
    }
    return parsed;
  }

  private async libraryFiles(libraryId: string): Promise<TofaLibraryFiles['items']> {
    const files: TofaLibraryFiles['items'] = [];
    let after: string | null | undefined = null;
    do {
      const page: TofaLibraryFiles = await this.request<TofaLibraryFiles>(
        `/media/files?library_id=${encodeURIComponent(libraryId)}&limit=${FILES_PAGE_LIMIT}` +
          (after ? `&after=${after}` : '')
      );
      files.push(...page.items);
      after = page.next_after;
    } while (after);
    return files;
  }

  /** Shows by id, and a show's episodes by season and number, so every page reads the same order */
  private episodeIndex(libraryId: string): Promise<EpisodeIndex> {
    return this.episodeIndexes.getOrInsertComputed(libraryId, async () => {
      const episodes = new Map<string, { showId: string; season: number; episode: number }>();
      for (const file of await this.libraryFiles(libraryId)) {
        if (!file.episode_id) continue;
        episodes.set(file.episode_id, {
          showId: file.media_id,
          season: file.season_number ?? 0,
          episode: file.episode_number ?? 0,
        });
      }
      const byShow = Map.groupBy(episodes, ([, { showId }]) => showId);
      return [...byShow.keys()].toSorted().map((showId) => ({
        showId,
        episodeIds: (byShow.get(showId) ?? [])
          .toSorted(([, a], [, b]) => a.season - b.season || a.episode - b.episode)
          .map(([id]) => id),
      }));
    });
  }

  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
  } as const;

  /**
   * Both full-admin and read-only keys are accepted. The health check needs no key, so
   * an unreachable server is told apart from a rejected key; only a 401 or 403 rejects it.
   */
  static async verifyServerAdmin(
    token: string,
    serverUrl: string
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    const url = serverUrl.replace(/\/$/, '');

    const refusal = probeRefusal(url);
    if (refusal) {
      return {
        success: false,
        code: TofaClient.AdminVerifyError.CONNECTION_FAILED,
        message: refusal,
      };
    }

    try {
      await fetchJson<unknown>(`${url}${API_PATH}/health`, {
        service: 'tofa',
        timeout: CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to connect to server';
      return {
        success: false,
        code: TofaClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot reach tofa server at ${url}. ${message}`,
      };
    }

    try {
      await new TofaClient({ url, token }).systemInfo();
      return { success: true };
    } catch (error) {
      if (isHttpStatus(error, 401, 403)) {
        return {
          success: false,
          code: TofaClient.AdminVerifyError.INVALID_KEY,
          message: 'tofa rejected this API key (it may be invalid, revoked or expired).',
        };
      }
      const message = error instanceof Error ? error.message : 'Unable to verify the API key';
      return {
        success: false,
        code: TofaClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Could not verify the API key on tofa server at ${url}. ${message}`,
      };
    }
  }

  /** The key Tracearr keeps for a server connected through tofa cloud; the secret is shown once. */
  static async createApiKey(
    url: string,
    sessionToken: string
  ): Promise<{ id: string; secret: string }> {
    const key = await fetchJson<{ id: string; secret: string }>(apiUrl(url, '/auth/api-keys'), {
      method: 'POST',
      headers: jsonHeaders(sessionToken),
      body: JSON.stringify({ name: 'Tracearr', read_only: true, can_stop_streams: true }),
      service: 'tofa',
      timeout: CONNECT_TIMEOUT_MS,
    });
    return { id: key.id, secret: key.secret };
  }

  static async deleteApiKey(url: string, sessionToken: string, keyId: string): Promise<void> {
    const response = await fetch(apiUrl(url, `/auth/api-keys/${encodeURIComponent(keyId)}`), {
      method: 'DELETE',
      headers: jsonHeaders(sessionToken),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`tofa refused to delete the API key: ${response.status}`);
  }

  static async logoutSession(url: string, sessionToken: string): Promise<boolean> {
    const response = await fetch(apiUrl(url, '/auth/session/logout'), {
      method: 'POST',
      headers: jsonHeaders(sessionToken),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    return response.ok;
  }

  /** Whether a tofa server answers at the address; the system info answers 401 without a key. */
  static async probe(url: string): Promise<boolean> {
    try {
      assertSafeProbeUrl(url);
      const response = await fetch(apiUrl(url, '/system/info'), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok || response.status === 401;
    } catch {
      return false;
    }
  }
}
