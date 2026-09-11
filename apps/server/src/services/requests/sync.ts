import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { createLogger } from '../../utils/logger.js';
import { mapSeerrRequest, type MappedRequest } from './mapping.js';
import { resolveRequests, type Resolved } from './resolution.js';
import {
  SeerrClient,
  type SeerrCounts,
  type SeerrRequest,
  type SeerrTitleLookup,
} from './seerrClient.js';
import { serverTypeById } from './serverLookup.js';
import {
  getRequestService,
  markRequestServiceReencrypt,
  publishRequestsChanged,
  readApiKey,
  recordSyncResult,
  type RequestServiceRow,
} from './store.js';

const logger = createLogger('request-sync');

export const PAGE_SIZE = 100;
const CURSOR_SLACK_MS = 5 * 60_000;
const LOOKUP_CONCURRENCY = 4;

export type SyncMode = 'incremental' | 'full';

export interface SeerrClientLike {
  requestCount(): Promise<SeerrCounts>;
  requestsPage(
    skip: number,
    take: number
  ): Promise<{ pageInfo: { pages: number }; results: SeerrRequest[] }>;
  movie(tmdbId: number): Promise<SeerrTitleLookup>;
  tv(tmdbId: number): Promise<SeerrTitleLookup>;
}

export interface SyncDeps {
  clientFor?: (row: RequestServiceRow, apiKey: string) => SeerrClientLike;
}

export interface SyncRunResult {
  skipped: boolean;
  upserted: number;
  markedDeleted: number;
}

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

async function lookupTitles(
  client: SeerrClientLike,
  rows: MappedRequest[]
): Promise<Map<number, SeerrTitleLookup>> {
  const out = new Map<number, SeerrTitleLookup>();
  const pending = [...new Map(rows.map((r) => [r.remoteMediaId, r])).values()];
  let index = 0;
  const worker = async () => {
    while (index < pending.length) {
      const row = pending[index++];
      if (!row || row.tmdbId == null) continue;
      try {
        const hit =
          row.mediaType === 'movie' ? await client.movie(row.tmdbId) : await client.tv(row.tmdbId);
        out.set(row.remoteMediaId, hit);
      } catch (error) {
        logger.warn('title lookup failed', { remoteMediaId: row.remoteMediaId, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, pending.length) }, worker));
  return out;
}

async function upsertBatch(
  serviceId: string,
  rows: MappedRequest[],
  resolved: Map<number, Resolved>,
  titles: Map<number, SeerrTitleLookup>
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  const values = rows.map((r) => {
    const match = resolved.get(r.remoteId);
    const lookup = titles.get(r.remoteMediaId);
    return sql`(
      ${serviceId}, ${r.remoteId}, ${r.remoteMediaId}, ${r.mediaType},
      ${match?.title ?? lookup?.title ?? null}, ${match?.year ?? lookup?.year ?? null},
      ${r.tmdbId}, ${r.tvdbId}, ${r.imdbId}, ${r.ratingKey},
      ${match?.mediaId ?? null}::uuid, ${match?.serverUserId ?? null}::uuid,
      ${r.remoteUserId}, ${r.remoteUsername}, ${r.remotePlexId}, ${r.remoteJellyfinUserId},
      ${r.status}, ${r.seasons === null ? null : JSON.stringify(r.seasons)}::jsonb, ${r.is4k}, ${r.isAutoRequest},
      ${r.requestedAt}, ${r.availableAt}, ${r.remoteUpdatedAt}, ${now}
    )`;
  });
  await db.execute(sql`
    INSERT INTO media_requests (
      service_id, remote_id, remote_media_id, media_type, title, year,
      tmdb_id, tvdb_id, imdb_id, rating_key, media_id, server_user_id,
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
      media_id = COALESCE(EXCLUDED.media_id, media_requests.media_id),
      server_user_id = COALESCE(EXCLUDED.server_user_id, media_requests.server_user_id),
      remote_user_id = EXCLUDED.remote_user_id, remote_username = EXCLUDED.remote_username,
      remote_plex_id = EXCLUDED.remote_plex_id, remote_jellyfin_user_id = EXCLUDED.remote_jellyfin_user_id,
      status = EXCLUDED.status, seasons = EXCLUDED.seasons,
      is_4k = EXCLUDED.is_4k, is_auto_request = EXCLUDED.is_auto_request,
      requested_at = EXCLUDED.requested_at, available_at = EXCLUDED.available_at,
      remote_updated_at = EXCLUDED.remote_updated_at, synced_at = EXCLUDED.synced_at,
      deleted_at = NULL, updated_at = now()
  `);
}

async function markMissingDeleted(serviceId: string, seenRemoteIds: number[]): Promise<number> {
  const result = await db.execute(sql`
    UPDATE media_requests SET deleted_at = now(), updated_at = now()
    WHERE service_id = ${serviceId} AND deleted_at IS NULL
      AND NOT (remote_id = ANY(${sql.param(seenRemoteIds)}::int[]))
  `);
  return result.rowCount ?? 0;
}

async function upsertAll(
  row: RequestServiceRow,
  client: SeerrClientLike,
  remote: SeerrRequest[]
): Promise<number> {
  const serverType = (await serverTypeById(row.serverId)) ?? 'plex';
  let upserted = 0;
  for (let i = 0; i < remote.length; i += PAGE_SIZE) {
    const mapped = remote.slice(i, i + PAGE_SIZE).map(mapSeerrRequest);
    const resolved = await resolveRequests(row.id, row.serverId, serverType, mapped);
    const unresolved = mapped.filter((r) => !resolved.get(r.remoteId)?.title);
    const titles = await lookupTitles(client, unresolved);
    await upsertBatch(row.id, mapped, resolved, titles);
    upserted += mapped.length;
  }
  return upserted;
}

export async function runRequestSync(
  serviceId: string,
  mode: SyncMode,
  deps: SyncDeps = {}
): Promise<SyncRunResult> {
  const row = await getRequestService(serviceId);
  if (!row || !row.enabled) return { skipped: true, upserted: 0, markedDeleted: 0 };

  const key = readApiKey(row);
  if (!key.ok) {
    await markRequestServiceReencrypt(row.id);
    await recordSyncResult(row.id, { lastSyncError: 'API key needs to be entered again' });
    return { skipped: true, upserted: 0, markedDeleted: 0 };
  }

  const client = deps.clientFor
    ? deps.clientFor(row, key.apiKey)
    : new SeerrClient(row.url, key.apiKey);
  const startedAt = new Date();
  try {
    const counts = await client.requestCount();
    if (mode === 'incremental' && sameCounts(row.lastCounts, counts)) {
      await recordSyncResult(row.id, { lastSyncAt: startedAt, lastSyncError: null });
      return { skipped: true, upserted: 0, markedDeleted: 0 };
    }

    const remote = await fetchRows(client, mode, row.syncCursor);
    const upserted = await upsertAll(row, client, remote);
    // A transient empty first page must not wipe every request the service still has upstream.
    const markedDeleted =
      mode === 'full' && !(remote.length === 0 && counts.total > 0)
        ? await markMissingDeleted(
            row.id,
            remote.map((r) => r.id)
          )
        : 0;

    const newest = remote.reduce<Date | null>((max, r) => {
      const at = new Date(r.updatedAt);
      return !max || at > max ? at : max;
    }, row.syncCursor);

    await recordSyncResult(row.id, {
      syncCursor: newest,
      lastCounts: counts,
      lastSyncAt: startedAt,
      ...(mode === 'full' ? { lastFullSyncAt: startedAt } : {}),
      lastSyncError: null,
    });
    if (upserted > 0 || markedDeleted > 0) await publishRequestsChanged(row.id);
    return { skipped: false, upserted, markedDeleted };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'sync failed';
    logger.error('request sync failed', { serviceId: row.id, error: message });
    await recordSyncResult(row.id, { lastSyncError: message.slice(0, 500) });
    throw error;
  }
}
