import type { MediaRequestStatus, RequestSeason } from '@tracearr/shared';
import type { mediaRequests } from '../../db/schema.js';
import type { SeerrRequest } from './seerrClient.js';

type InsertRow = typeof mediaRequests.$inferInsert;

export type MappedRequest = Omit<
  InsertRow,
  | 'id'
  | 'serviceId'
  | 'mediaId'
  | 'serverUserId'
  | 'title'
  | 'year'
  | 'syncedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
>;

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

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function mapSeerrRequest(row: SeerrRequest): MappedRequest {
  const status = mapRequestStatus(row.status);
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
    remoteId: row.id,
    remoteMediaId: row.media.id,
    mediaType: row.type === 'tv' ? 'show' : 'movie',
    tmdbId: row.media.tmdbId ?? null,
    tvdbId: row.media.tvdbId ?? null,
    imdbId: row.media.imdbId ?? null,
    ratingKey: row.media.ratingKey ?? null,
    remoteUserId: row.requestedBy.id,
    remoteUsername: row.requestedBy.displayName,
    remotePlexId: row.requestedBy.plexId != null ? String(row.requestedBy.plexId) : null,
    remoteJellyfinUserId: row.requestedBy.jellyfinUserId ?? null,
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
