import type { MediaRequestStatus } from '@tracearr/shared';
import { createLogger } from '../../../utils/logger.js';
import { toDate, type MappedRequest } from '../../requests/mapping.js';
import { SILO_REQUEST_POSTER_PATH } from './parser.js';
import type { SiloRequest, SiloRequestSeasonProgress } from './types.js';

const log = createLogger('silo-client');

const STATUS_BY_STATE: Record<string, MediaRequestStatus> = {
  pending: 'pending',
  approved: 'approved',
  processing: 'approved',
  partially_available: 'approved',
  available: 'completed',
  declined: 'declined',
  failed: 'failed',
};

/** null for cancelled, which Silo keeps but no longer shows as asked for, and for a state Tracearr does not know */
export function mapSiloRequestState(state: string): MediaRequestStatus | null {
  return STATUS_BY_STATE[state] ?? null;
}

const seasonComplete = (progress: SiloRequestSeasonProgress | undefined) =>
  !!progress &&
  progress.episodes_aired > 0 &&
  progress.episodes_available >= progress.episodes_aired;

/** Status comes from state: a cancelled request keeps status pending */
export function mapSiloRequest(
  row: SiloRequest,
  usernames: ReadonlyMap<string, string>
): MappedRequest | null {
  const status = mapSiloRequestState(row.state);
  if (!status) {
    if (row.state !== 'cancelled') {
      log.warn(`Silo request ${row.id} is in an unknown state ${row.state}, left out`);
    }
    return null;
  }
  const remoteUserId = row.requested_by_user_id ?? '';
  return {
    remoteId: row.id,
    remoteMediaId: null,
    mediaType: row.media_type === 'series' ? 'show' : 'movie',
    title: row.title,
    tmdbId: row.tmdb_id,
    tvdbId: row.tvdb_id ?? null,
    imdbId: row.imdb_id ?? null,
    ratingKey: row.library_content_id ?? null,
    remoteUserId,
    remoteUsername: usernames.get(remoteUserId) ?? remoteUserId,
    remotePlexId: null,
    remoteJellyfinUserId: null,
    remoteProfileId: row.requested_by_profile_id ?? null,
    status,
    seasons:
      row.media_type === 'series'
        ? row.seasons.map((seasonNumber) => ({
            seasonNumber,
            status:
              row.state === 'available' ||
              seasonComplete(row.season_progress.find((p) => p.season_number === seasonNumber))
                ? 'completed'
                : status,
          }))
        : null,
    posterPath:
      row.poster_url && SILO_REQUEST_POSTER_PATH.test(row.poster_url) ? row.poster_url : null,
    // A Silo request covers every quality it routes to
    is4k: false,
    isAutoRequest: row.source === 'watchlist',
    requestedAt: new Date(row.created_at),
    availableAt:
      status === 'completed' ? (toDate(row.completed_at) ?? new Date(row.updated_at)) : null,
    remoteUpdatedAt: new Date(row.updated_at),
  };
}
