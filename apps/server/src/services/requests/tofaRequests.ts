import type { MediaRequestStatus } from '@tracearr/shared';
import type { TofaRequest } from '../mediaServer/tofa/types.js';
import { toDate, type MappedRequest } from './mapping.js';

const STATUS_BY_NAME: Record<string, MediaRequestStatus> = {
  pending_approval: 'pending',
  requested: 'approved',
  downloading: 'approved',
  retrying: 'approved',
  available: 'completed',
  denied: 'declined',
  failed: 'failed',
};

export function mapTofaRequestStatus(status: string): MediaRequestStatus {
  return STATUS_BY_NAME[status] ?? 'pending';
}

/**
 * tofa requests name their media by tmdb and tvdb id and carry the title. A request landed when
 * tofa resolved it, or at its last update when tofa left no resolved time.
 */
export function mapTofaRequest(row: TofaRequest): MappedRequest {
  const status = mapTofaRequestStatus(row.status);
  const remoteUpdatedAt = new Date(row.updated_at);
  return {
    remoteId: row.id,
    remoteMediaId: null,
    mediaType: row.media_type === 'tv' ? 'show' : 'movie',
    title: row.title,
    tmdbId: row.tmdb_id,
    tvdbId: row.tvdb_id ?? null,
    imdbId: null,
    ratingKey: null,
    remoteUserId: row.requested_by,
    remoteUsername: row.requested_by_name ?? row.requested_by,
    remotePlexId: null,
    remoteJellyfinUserId: null,
    status,
    seasons:
      row.media_type === 'tv'
        ? row.seasons.map((s) => ({
            seasonNumber: s.season_number,
            status: mapTofaRequestStatus(s.status),
          }))
        : null,
    is4k: row.is4k,
    isAutoRequest: false,
    requestedAt: new Date(row.created_at),
    availableAt: status === 'completed' ? (toDate(row.resolved_at) ?? remoteUpdatedAt) : null,
    remoteUpdatedAt,
  };
}
