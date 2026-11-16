import { sql } from 'drizzle-orm';
import { assertNever, type ServerType } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { TofaClient } from '../mediaServer/tofa/client.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { createLogger } from '../../utils/logger.js';
import { seerrPosterPath } from '../imageProxy.js';
import { mapSeerrRequest, type MappedRequest } from './mapping.js';
import { resolveRequests, type Resolved } from './resolution.js';
import {
  SeerrClient,
  type SeerrCounts,
  type SeerrRequest,
  type SeerrTitleLookup,
} from './seerrClient.js';
import { liveServerConnection, serverTypeById } from './serverLookup.js';
import {
  getRequestService,
  markRequestServiceReencrypt,
  mirroredRequests,
  publishRequestsChanged,
  readApiKey,
  recordSyncResult,
  type MirroredRequest,
  type RequestServiceRow,
} from './store.js';
import { mapTofaRequest } from './tofaRequests.js';

const logger = createLogger('request-sync');

export const PAGE_SIZE = 100;
const CURSOR_SLACK_MS = 5 * 60_000;
const LOOKUP_CONCURRENCY = 4;

export type SyncMode = 'incremental' | 'full';

export interface SeerrClientLike {
  status(): Promise<{ version: string }>;
  mainSettings(): Promise<{ cacheImages: boolean }>;
  requestCount(): Promise<SeerrCounts>;
  requestsPage(
    skip: number,
    take: number
  ): Promise<{ pageInfo: { pages: number }; results: SeerrRequest[] }>;
  movie(tmdbId: number): Promise<SeerrTitleLookup>;
  tv(tmdbId: number): Promise<SeerrTitleLookup>;
}

export type TofaRequestSource = Pick<
  TofaClient,
  'systemInfo' | 'getRequests' | 'getRequestPosterPath'
>;

export interface SyncDeps {
  clientFor?: (row: RequestServiceRow, apiKey: string) => SeerrClientLike;
  tofaClientFor?: (server: { url: string; token: string }) => TofaRequestSource;
}

export interface SyncRunResult {
  skipped: boolean;
  upserted: number;
  markedDeleted: number;
}

const SKIPPED: SyncRunResult = { skipped: true, upserted: 0, markedDeleted: 0 };

/** What a sync asked the service for, by remote id */
type Lookups = Map<
  string,
  { title: string | null; year: number | null; posterPath: string | null }
>;

function sameCounts(a: SeerrCounts | null, b: SeerrCounts): boolean {
  return !!a && (Object.keys(b) as (keyof SeerrCounts)[]).every((k) => a[k] === b[k]);
}

async function fetchRows(
  client: SeerrClientLike,
  mode: SyncMode,
  cursor: Date | null
): Promise<SeerrRequest[]> {
  const stopBefore = mode === 'incremental' && cursor ? cursor.getTime() - CURSOR_SLACK_MS : null;
  const rows: SeerrRequest[] = [];
  for (let page = 0; ; page++) {
    const result = await client.requestsPage(page * PAGE_SIZE, PAGE_SIZE);
    let reachedCursor = false;
    for (const row of result.results) {
      if (stopBefore !== null && new Date(row.updatedAt).getTime() < stopBefore) {
        reachedCursor = true;
        break;
      }
      rows.push(row);
    }
    if (reachedCursor || result.results.length < PAGE_SIZE || page + 1 >= result.pageInfo.pages)
      break;
  }
  return rows;
}

/**
 * A request whose title is in no library shows the poster its service gives. The service is
 * asked when the mirror first sees the request and again on each full run until one comes back.
 */
function wantsPoster(
  row: MappedRequest,
  resolved: Map<string, Resolved>,
  mirrored: Map<string, MirroredRequest>,
  mode: SyncMode
): boolean {
  const stored = mirrored.get(row.remoteId);
  return !resolved.get(row.remoteId)?.mediaId && !stored?.postered && (!stored || mode === 'full');
}

/** One Seerr lookup per media; its poster is kept only while Seerr's image cache serves it. */
async function lookupSeerrMedia(
  client: SeerrClientLike,
  rows: MappedRequest[],
  cacheImages: boolean
): Promise<Lookups> {
  const hits = new Map<MappedRequest['remoteMediaId'], SeerrTitleLookup>();
  const pending = [...new Map(rows.map((r) => [r.remoteMediaId, r])).values()];
  await mapWithConcurrency(pending, LOOKUP_CONCURRENCY, async (row) => {
    if (row.tmdbId == null) return;
    try {
      const hit =
        row.mediaType === 'movie' ? await client.movie(row.tmdbId) : await client.tv(row.tmdbId);
      hits.set(row.remoteMediaId, hit);
    } catch (error) {
      logger.warn('title lookup failed', { remoteMediaId: row.remoteMediaId, error });
    }
  });
  const out: Lookups = new Map();
  for (const row of rows) {
    const hit = hits.get(row.remoteMediaId);
    if (!hit) continue;
    out.set(row.remoteId, {
      title: hit.title,
      year: hit.year,
      posterPath: cacheImages ? seerrPosterPath(hit.posterPath) : null,
    });
  }
  return out;
}

async function lookupTofaPosters(
  client: TofaRequestSource,
  rows: MappedRequest[]
): Promise<Lookups> {
  const out: Lookups = new Map();
  await mapWithConcurrency(rows, LOOKUP_CONCURRENCY, async (row) => {
    if (row.tmdbId == null) return;
    try {
      const posterPath = await client.getRequestPosterPath(
        row.mediaType === 'show' ? 'tv' : 'movie',
        row.tmdbId
      );
      out.set(row.remoteId, { title: null, year: null, posterPath });
    } catch (error) {
      logger.warn('poster lookup failed', { remoteId: row.remoteId, error });
    }
  });
  return out;
}

async function upsertBatch(
  serviceId: string,
  rows: MappedRequest[],
  resolved: Map<string, Resolved>,
  lookups: Lookups
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  const values = rows.map((r) => {
    const match = resolved.get(r.remoteId);
    const lookup = lookups.get(r.remoteId);
    return sql`(
      ${serviceId}, ${r.remoteId}, ${r.remoteMediaId}, ${r.mediaType},
      ${match?.title ?? lookup?.title ?? r.title}, ${match?.year ?? lookup?.year ?? null},
      ${r.tmdbId}, ${r.tvdbId}, ${r.imdbId}, ${r.ratingKey}, ${lookup?.posterPath ?? null},
      ${match?.mediaId ?? null}::uuid, ${match?.serverUserId ?? null}::uuid,
      ${r.remoteUserId}, ${r.remoteUsername}, ${r.remotePlexId}, ${r.remoteJellyfinUserId},
      ${r.status}, ${r.seasons === null ? null : JSON.stringify(r.seasons)}::jsonb, ${r.is4k}, ${r.isAutoRequest},
      ${r.requestedAt}, ${r.availableAt}, ${r.remoteUpdatedAt}, ${now}
    )`;
  });
  await db.execute(sql`
    INSERT INTO media_requests (
      service_id, remote_id, remote_media_id, media_type, title, year,
      tmdb_id, tvdb_id, imdb_id, rating_key, poster_path, media_id, server_user_id,
      remote_user_id, remote_username, remote_plex_id, remote_jellyfin_user_id,
      status, seasons, is_4k, is_auto_request, requested_at, available_at, remote_updated_at, synced_at
    ) VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (service_id, remote_id) DO UPDATE SET
      remote_media_id = EXCLUDED.remote_media_id,
      media_type = EXCLUDED.media_type,
      title = COALESCE(EXCLUDED.title, media_requests.title),
      year = COALESCE(EXCLUDED.year, media_requests.year),
      tmdb_id = EXCLUDED.tmdb_id, tvdb_id = EXCLUDED.tvdb_id, imdb_id = EXCLUDED.imdb_id,
      rating_key = EXCLUDED.rating_key,
      poster_path = COALESCE(EXCLUDED.poster_path, media_requests.poster_path),
      media_id = COALESCE(EXCLUDED.media_id, media_requests.media_id),
      server_user_id = COALESCE(EXCLUDED.server_user_id, media_requests.server_user_id),
      remote_user_id = EXCLUDED.remote_user_id, remote_username = EXCLUDED.remote_username,
      remote_plex_id = EXCLUDED.remote_plex_id, remote_jellyfin_user_id = EXCLUDED.remote_jellyfin_user_id,
      -- A request counted as landed only because its media was available stays
      -- landed if the media later goes away, as a Seerr COMPLETED request does.
      status = CASE
        WHEN EXCLUDED.status = 'approved' AND media_requests.available_at IS NOT NULL THEN 'completed'
        ELSE EXCLUDED.status
      END,
      seasons = EXCLUDED.seasons,
      is_4k = EXCLUDED.is_4k, is_auto_request = EXCLUDED.is_auto_request,
      requested_at = EXCLUDED.requested_at,
      available_at = CASE
        WHEN EXCLUDED.status IN ('approved', 'completed') THEN COALESCE(EXCLUDED.available_at, media_requests.available_at)
        ELSE EXCLUDED.available_at
      END,
      remote_updated_at = EXCLUDED.remote_updated_at, synced_at = EXCLUDED.synced_at,
      deleted_at = NULL, updated_at = now()
  `);
}

async function markMissingDeleted(serviceId: string, seenRemoteIds: string[]): Promise<number> {
  const result = await db.execute(sql`
    UPDATE media_requests SET deleted_at = now(), updated_at = now()
    WHERE service_id = ${serviceId} AND deleted_at IS NULL
      AND NOT (remote_id = ANY(${sql.param(seenRemoteIds)}::text[]))
  `);
  return result.rowCount ?? 0;
}

/** With Seerr's image cache off its /imageproxy answers 404, so the stored paths are dropped. */
async function clearPosters(serviceId: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE media_requests SET poster_path = NULL, updated_at = now()
    WHERE service_id = ${serviceId} AND poster_path IS NOT NULL
  `);
  return result.rowCount ?? 0;
}

async function upsertAll(
  row: RequestServiceRow,
  serverType: ServerType,
  mapped: MappedRequest[],
  lookupsFor: (page: MappedRequest[], resolved: Map<string, Resolved>) => Promise<Lookups>
): Promise<number> {
  let upserted = 0;
  for (let i = 0; i < mapped.length; i += PAGE_SIZE) {
    const page = mapped.slice(i, i + PAGE_SIZE);
    const resolved = await resolveRequests(row.serverId, serverType, page);
    const lookups = await lookupsFor(page, resolved);
    await upsertBatch(row.id, page, resolved, lookups);
    upserted += page.length;
  }
  return upserted;
}

async function syncSeerr(
  row: RequestServiceRow,
  mode: SyncMode,
  deps: SyncDeps
): Promise<SyncRunResult> {
  const key = readApiKey(row);
  if (!key.ok) {
    await markRequestServiceReencrypt(row.id);
    await recordSyncResult(row.id, { lastSyncError: 'API key needs to be entered again' });
    return SKIPPED;
  }

  const client = deps.clientFor
    ? deps.clientFor(row, key.apiKey)
    : new SeerrClient(row.url, key.apiKey);
  const startedAt = new Date();
  const [counts, { version }] = await Promise.all([client.requestCount(), client.status()]);
  if (mode === 'incremental' && sameCounts(row.lastCounts, counts)) {
    await recordSyncResult(row.id, { version, lastSyncAt: startedAt, lastSyncError: null });
    return SKIPPED;
  }

  const [remote, { cacheImages }] = await Promise.all([
    fetchRows(client, mode, row.syncCursor),
    client.mainSettings(),
  ]);
  const mapped = remote.map(mapSeerrRequest);
  const serverType = (await serverTypeById(row.serverId)) ?? 'plex';
  const mirrored = await mirroredRequests(row.id);
  const clearedPosters =
    !cacheImages && [...mirrored.values()].some((stored) => stored.postered)
      ? await clearPosters(row.id)
      : 0;
  const upserted = await upsertAll(row, serverType, mapped, (page, resolved) =>
    lookupSeerrMedia(
      client,
      page.filter(
        (r) =>
          (!resolved.get(r.remoteId)?.title && !mirrored.get(r.remoteId)?.titled) ||
          (cacheImages && wantsPoster(r, resolved, mirrored, mode))
      ),
      cacheImages
    )
  );
  // A walk shorter than the service's own count means rows were missed: the
  // result window shifted under the paging, or the first page came back
  // empty. Those rows are still upstream, so the cleanup pass waits.
  const markedDeleted =
    mode === 'full' && remote.length >= counts.total
      ? await markMissingDeleted(
          row.id,
          mapped.map((r) => r.remoteId)
        )
      : 0;

  const newest = remote.reduce<Date | null>((max, r) => {
    const at = new Date(r.updatedAt);
    return !max || at > max ? at : max;
  }, row.syncCursor);

  await recordSyncResult(row.id, {
    version,
    syncCursor: newest,
    lastCounts: counts,
    lastSyncAt: startedAt,
    ...(mode === 'full' ? { lastFullSyncAt: startedAt } : {}),
    lastSyncError: null,
  });
  if (upserted > 0 || markedDeleted > 0 || clearedPosters > 0) {
    await publishRequestsChanged(row.id);
  }
  return { skipped: false, upserted, markedDeleted };
}

/**
 * tofa lists every request in one response and keeps no trace of a deleted one, so every run
 * lists them all and marks the rest deleted.
 */
async function syncTofa(
  row: RequestServiceRow,
  mode: SyncMode,
  deps: SyncDeps
): Promise<SyncRunResult> {
  const server = await liveServerConnection(row.serverId);
  if (!server) return SKIPPED;

  const client = deps.tofaClientFor ? deps.tofaClientFor(server) : new TofaClient(server);
  const startedAt = new Date();
  const info = await client.systemInfo();
  if (!info.requests_available) {
    await recordSyncResult(row.id, {
      version: info.version,
      lastSyncAt: startedAt,
      lastSyncError: 'Requests are turned off on this tofa server',
      takesRequests: false,
    });
    if (row.takesRequests) await publishRequestsChanged(row.id);
    return SKIPPED;
  }

  const mapped = (await client.getRequests()).map(mapTofaRequest);
  const mirrored = await mirroredRequests(row.id);
  const upserted = await upsertAll(row, 'tofa', mapped, (page, resolved) =>
    lookupTofaPosters(
      client,
      page.filter((r) => wantsPoster(r, resolved, mirrored, mode))
    )
  );
  const markedDeleted = await markMissingDeleted(
    row.id,
    mapped.map((r) => r.remoteId)
  );

  await recordSyncResult(row.id, {
    version: info.version,
    lastSyncAt: startedAt,
    ...(mode === 'full' ? { lastFullSyncAt: startedAt } : {}),
    lastSyncError: null,
    takesRequests: true,
  });
  if (upserted > 0 || markedDeleted > 0 || !row.takesRequests) {
    await publishRequestsChanged(row.id);
  }
  return { skipped: false, upserted, markedDeleted };
}

export async function runRequestSync(
  serviceId: string,
  mode: SyncMode,
  deps: SyncDeps = {}
): Promise<SyncRunResult> {
  const row = await getRequestService(serviceId);
  if (!row || !row.enabled) return SKIPPED;

  try {
    switch (row.type) {
      case 'seerr':
        return await syncSeerr(row, mode, deps);
      case 'tofa':
        return await syncTofa(row, mode, deps);
      default:
        return assertNever(row.type);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'sync failed';
    logger.error('request sync failed', { serviceId: row.id, error: message });
    await recordSyncResult(row.id, { lastSyncError: message.slice(0, 500) });
    throw error;
  }
}
