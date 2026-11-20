import { sql, type SQL } from 'drizzle-orm';
import {
  assertNever,
  type MediaRequestStatus,
  type RequestSeason,
  type ServerType,
} from '@tracearr/shared';
import type { mediaRequests } from '../../db/schema.js';
import type { ResolutionInput } from './resolution.js';
import type { SeerrRequest } from './seerrClient.js';

type InsertRow = typeof mediaRequests.$inferInsert;

export type MappedRequest = Omit<
  InsertRow,
  | 'id'
  | 'serviceId'
  | 'mediaId'
  | 'serverUserId'
  | 'profileId'
  | 'year'
  | 'syncedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
> & {
  /** The server's own id for the profile that asked */
  remoteProfileId: string | null;
};

const STATUS_BY_CODE: Record<number, MediaRequestStatus> = {
  1: 'pending',
  2: 'approved',
  3: 'declined',
  4: 'failed',
  5: 'completed',
};

export function mapRequestStatus(status: number): MediaRequestStatus {
  return STATUS_BY_CODE[status] ?? 'pending';
}

/**
 * Seerr stamps completions from a five-minute cron, so mediaAddedAt is the
 * honest landing time unless the media predates the request (a new season of
 * a show already on the server), where the request's own updatedAt is all
 * there is.
 */
export function deriveAvailableAt(
  status: MediaRequestStatus,
  requestedAt: Date,
  mediaAddedAt: Date | null,
  remoteUpdatedAt: Date
): Date | null {
  if (status !== 'completed') return null;
  if (mediaAddedAt && mediaAddedAt.getTime() >= requestedAt.getTime()) return mediaAddedAt;
  return remoteUpdatedAt;
}

export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const MEDIA_AVAILABLE = 5;

/**
 * Seerr writes COMPLETED only on a media status change seen while the request
 * is approved, and versions from before COMPLETED existed left finished
 * requests approved with no backfill. Seerr's own "available" count is
 * approved plus available media, so that counts as completed here too.
 */
function effectiveStatus(row: SeerrRequest): MediaRequestStatus {
  const status = mapRequestStatus(row.status);
  const mediaStatus = row.is4k ? row.media.status4k : row.media.status;
  return status === 'approved' && mediaStatus === MEDIA_AVAILABLE ? 'completed' : status;
}

export function mapSeerrRequest(row: SeerrRequest): MappedRequest {
  const status = effectiveStatus(row);
  const requestedAt = new Date(row.createdAt);
  const remoteUpdatedAt = new Date(row.updatedAt);
  const seasons: RequestSeason[] | null =
    row.type === 'tv'
      ? row.seasons.map((s) => ({
          seasonNumber: s.seasonNumber,
          status: mapRequestStatus(s.status),
        }))
      : null;
  return {
    remoteId: String(row.id),
    remoteMediaId: row.media.id,
    mediaType: row.type === 'tv' ? 'show' : 'movie',
    title: null,
    tmdbId: row.media.tmdbId ?? null,
    tvdbId: row.media.tvdbId ?? null,
    imdbId: row.media.imdbId ?? null,
    ratingKey: row.media.ratingKey ?? row.media.jellyfinMediaId ?? null,
    remoteUserId: String(row.requestedBy.id),
    remoteUsername: row.requestedBy.displayName,
    remotePlexId: row.requestedBy.plexId != null ? String(row.requestedBy.plexId) : null,
    remoteJellyfinUserId: row.requestedBy.jellyfinUserId ?? null,
    remoteProfileId: null,
    status,
    seasons,
    is4k: row.is4k,
    isAutoRequest: row.isAutoRequest,
    requestedAt,
    availableAt: deriveAvailableAt(
      status,
      requestedAt,
      toDate(row.media.mediaAddedAt),
      remoteUpdatedAt
    ),
    remoteUpdatedAt,
  };
}

/** The server_users column a request's requester matches, and the request field it matches by */
export interface RequesterIdentity {
  column: SQL;
  key: (r: ResolutionInput) => string | null | undefined;
}

/** A server's own requests name the requester by the server's own user id */
export const BUILT_IN_REQUESTER: RequesterIdentity = {
  column: sql`external_id`,
  key: (r) => r.remoteUserId,
};

/**
 * Seerr names a Plex requester by plex.tv account id, a Jellyfin or Emby requester by the
 * server's own user id.
 */
export function seerrRequesterIdentity(serverType: ServerType): RequesterIdentity {
  switch (serverType) {
    case 'plex':
      return { column: sql`plex_account_id`, key: (r) => r.remotePlexId };
    case 'jellyfin':
    case 'emby':
      return { column: sql`external_id`, key: (r) => r.remoteJellyfinUserId };
    // request_services is unique per server, so no server with its own requests links to Seerr
    case 'tofa':
      return BUILT_IN_REQUESTER;
    default:
      return assertNever(serverType);
  }
}
