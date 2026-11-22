/**
 * tofa Watch History Import Service
 *
 * Pages tofa's own record of finished plays from the newest back to the oldest and inserts
 * the plays Tracearr did not capture itself.
 */

import { SESSION_LIMITS, type TofaImportProgress, type TofaImportResult } from '@tracearr/shared';
import type { sessions } from '../../db/schema.js';
import { normalizeClient } from '../../utils/platformNormalizer.js';
import type { PubSubService } from '../cache.js';
import { geoipService } from '../geoip.js';
import {
  parseProfileNaming,
  playMethodDecisions,
  tofaPosterPath,
} from '../mediaServer/tofa/parser.js';
import type { TofaWatchHistoryRow } from '../mediaServer/tofa/types.js';
import { importIdentityByKey } from './libraryKeyMatch.js';
import {
  importServerHistory,
  type HistoryPlay,
  type HistoryPlayContext,
  type ServerHistory,
} from './serverHistory.js';
import { historyServer, watchHistoryPages } from './tofaWatchHistory.js';

/** An episode plays under the episode's id, everything else under the media's */
function historyItem(row: TofaWatchHistoryRow): {
  ratingKey: string | null;
  mediaType: 'movie' | 'episode' | 'unknown';
} {
  switch (row.media_type) {
    case 'tv':
      return { ratingKey: row.episode_id ?? null, mediaType: 'episode' };
    case 'movie':
      return { ratingKey: row.media_id ?? null, mediaType: 'movie' };
    default:
      return { ratingKey: row.media_id ?? null, mediaType: 'unknown' };
  }
}

/**
 * A finished play as a stopped session. Time watched is the span from start to end: tofa's
 * own seconds_watched undercounts wall time and is not used. tofa keeps no pause total, so that
 * span can hold a long pause, and a play counts as watched by its final position against the
 * server's rule.
 */
function transformTofaHistoryRow(
  row: TofaWatchHistoryRow,
  endedAt: Date,
  ctx: HistoryPlayContext & { profileName: string | null }
): typeof sessions.$inferInsert {
  const startedAt = new Date(row.started_at);
  const durationMs = Math.max(endedAt.getTime() - startedAt.getTime(), 0);
  const { ratingKey, mediaType } = historyItem(row);
  const mediaTitle = mediaType === 'episode' ? (row.episode_title ?? row.title) : row.title;
  const identity = importIdentityByKey(ctx.identity, { mediaType, title: mediaTitle, year: null });
  const totalDurationMs = row.duration_ms ?? null;
  const { videoDecision, audioDecision, isTranscode } = playMethodDecisions(row.play_method);
  const clientName = row.client_name ?? '';
  const normalized = normalizeClient(
    clientName || (row.platform ?? ''),
    row.device_model ?? '',
    'tofa'
  );
  const ipAddress = row.client_ip ?? '';

  return {
    serverId: ctx.serverId,
    serverUserId: ctx.serverUserId,
    // The imported form importDuplicateCleanup recognizes; a later import skips it by the history id
    sessionKey: `tofa-${row.id}`,
    externalSessionId: row.id,
    ratingKey,
    parentRatingKey: identity?.parentRatingKey ?? null,
    grandparentRatingKey: identity?.grandparentRatingKey ?? null,
    mediaId: identity?.mediaId ?? null,
    showMediaId: identity?.showMediaId ?? null,
    imdbId: identity?.imdbId ?? null,
    tmdbId: identity?.tmdbId ?? null,
    tvdbId: identity?.tvdbId ?? null,
    state: 'stopped',
    mediaType,
    mediaTitle,
    grandparentTitle: mediaType === 'episode' ? row.title : null,
    seasonNumber: row.season_number ?? null,
    episodeNumber: row.episode_number ?? null,
    year: identity?.itemYear ?? null,
    thumbPath: row.media_id ? tofaPosterPath(row.media_id) : null,
    startedAt,
    lastSeenAt: endedAt,
    stoppedAt: endedAt,
    durationMs,
    totalDurationMs,
    progressMs: row.position_ms,
    pausedDurationMs: 0,
    watched: totalDurationMs !== null && row.position_ms / totalDurationMs >= ctx.threshold,
    shortSession: durationMs < SESSION_LIMITS.MIN_PLAY_TIME_MS,
    ipAddress,
    geoCity: ctx.geo.city,
    geoRegion: ctx.geo.region,
    geoCountry: ctx.geo.countryCode ?? ctx.geo.country,
    geoContinent: ctx.geo.continent,
    geoPostal: ctx.geo.postal,
    geoLat: ctx.geo.lat,
    geoLon: ctx.geo.lon,
    geoAsnNumber: ctx.geo.asnNumber,
    geoAsnOrganization: ctx.geo.asnOrganization,
    isLocal: ipAddress ? geoipService.isPrivateIP(ipAddress) : null,
    profileName: ctx.profileName,
    profileId: ctx.profileId,
    playerName: (row.device_name ?? clientName).slice(0, 255) || null,
    device: normalized.device.slice(0, 255),
    deviceId: row.device_id ?? null,
    product: clientName.slice(0, 255) || null,
    platform: normalized.platform.slice(0, 100),
    quality: isTranscode ? 'Transcode' : 'Direct',
    isTranscode,
    videoDecision,
    audioDecision,
    bitrate: null,
  };
}

function tofaHistoryPlay(row: TofaWatchHistoryRow): HistoryPlay {
  const { ratingKey, mediaType } = historyItem(row);
  return {
    historyId: row.id,
    sessionId: row.session_id ?? null,
    accountId: row.user_id,
    username: row.username,
    profile: parseProfileNaming(row),
    ratingKey,
    mediaType,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
    ipAddress: row.client_ip ?? '',
  };
}

async function tofaHistory(serverId: string): Promise<ServerHistory<TofaWatchHistoryRow>> {
  const { server, client } = await historyServer(serverId);
  return {
    server,
    label: 'TofaHistory',
    pages: (beforeFetch) => watchHistoryPages(client, beforeFetch),
    play: tofaHistoryPlay,
    toSession: (row, play, endedAt, ctx) =>
      transformTofaHistoryRow(row, endedAt, {
        ...ctx,
        profileName: play.profile.profileName ?? null,
      }),
  };
}

/** Syncs the server's users first, so the import never relies on a sync that ran before it. */
export async function importTofaHistory(
  serverId: string,
  pubSubService?: PubSubService,
  onProgress?: (progress: TofaImportProgress) => Promise<void>
): Promise<TofaImportResult> {
  return importServerHistory(serverId, () => tofaHistory(serverId), pubSubService, onProgress);
}
