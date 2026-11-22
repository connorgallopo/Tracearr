/**
 * Silo Watch History Import Service
 *
 * Pages Silo's own record of finished plays from the newest ended back and inserts the plays
 * Tracearr did not capture itself.
 */

import {
  REDIS_KEYS,
  SESSION_LIMITS,
  type ServerHistoryImportProgress,
  type ServerHistoryImportResult,
} from '@tracearr/shared';
import type { sessions } from '../../db/schema.js';
import { getRedis } from '../../lib/redisShared.js';
import { normalizeClient } from '../../utils/platformNormalizer.js';
import type { PubSubService } from '../cache.js';
import { geoipService } from '../geoip.js';
import { SiloClient } from '../mediaServer/silo/client.js';
import {
  siloHistoryProfileNaming,
  siloItemPosterPath,
  siloMediaType,
  siloStreamDecisions,
  siloWatchedSeconds,
} from '../mediaServer/silo/parser.js';
import type { SiloHistoryRow } from '../mediaServer/silo/types.js';
import { importIdentityByKey } from './libraryKeyMatch.js';
import {
  historyServerRow,
  importServerHistory,
  type HistoryPlay,
  type HistoryPlayContext,
  type ServerHistory,
} from './serverHistory.js';

// Silo stamps ended_at as each replica finalizes a play, so a row can commit after one stamped
// later; the overlap reads it again and dedup skips what Tracearr has
const CURSOR_OVERLAP_MS = 60 * 60 * 1000;

interface SiloHistoryEntry {
  row: SiloHistoryRow;
  deviceName: string | undefined;
}

function siloHistoryPlay({ row }: SiloHistoryEntry): HistoryPlay {
  return {
    historyId: row.session_id,
    sessionId: row.session_id,
    accountId: row.user_id,
    username: row.username || null,
    profile: siloHistoryProfileNaming(row),
    ratingKey: row.media_item_id || null,
    mediaType: siloMediaType(row.media_type),
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    ipAddress: row.client_ip ?? '',
  };
}

/**
 * A finished play as a stopped session. Time watched is Silo's measurement, else the estimate
 * Silo's own history page shows; progress is where the play ended, and the play counts as
 * watched by Tracearr's threshold on that position, never by Silo's completed flag.
 */
function transformSiloHistoryRow(
  { row, deviceName }: SiloHistoryEntry,
  play: HistoryPlay,
  endedAt: Date,
  ctx: HistoryPlayContext
): typeof sessions.$inferInsert {
  const { mediaType } = play;
  const identity = importIdentityByKey(ctx.identity, {
    mediaType,
    title: row.media_title,
    year: null,
  });
  const durationMs = Math.round(siloWatchedSeconds(row) * 1000);
  const progressMs = Math.round(row.end_position_seconds * 1000);
  const totalDurationMs =
    row.duration_seconds === null ? null : Math.round(row.duration_seconds * 1000);
  const { videoDecision, audioDecision, isTranscode } = siloStreamDecisions(
    row.video_decision,
    row.audio_decision
  );
  const normalized = normalizeClient(row.client_name || row.device_platform || '', '', 'silo');
  const ipAddress = play.ipAddress;

  return {
    serverId: ctx.serverId,
    serverUserId: ctx.serverUserId,
    // The imported form; a later import skips it by its session id
    sessionKey: `silo-${row.session_id}`,
    externalSessionId: row.session_id,
    ratingKey: play.ratingKey,
    serverVersionKey: row.media_file_id || null,
    parentRatingKey: identity?.parentRatingKey ?? null,
    grandparentRatingKey: identity?.grandparentRatingKey ?? null,
    mediaId: identity?.mediaId ?? null,
    showMediaId: identity?.showMediaId ?? null,
    imdbId: identity?.imdbId ?? null,
    tmdbId: identity?.tmdbId ?? null,
    tvdbId: identity?.tvdbId ?? null,
    state: 'stopped',
    mediaType,
    mediaTitle: row.media_title,
    grandparentTitle: mediaType === 'episode' ? row.series_title || null : null,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    year: identity?.itemYear ?? null,
    thumbPath: row.media_item_id ? (siloItemPosterPath(row.media_item_id) ?? null) : null,
    startedAt: play.startedAt,
    lastSeenAt: endedAt,
    stoppedAt: endedAt,
    durationMs,
    totalDurationMs,
    progressMs,
    pausedDurationMs: Math.round((row.paused_seconds ?? 0) * 1000),
    watched:
      totalDurationMs !== null &&
      totalDurationMs > 0 &&
      progressMs / totalDurationMs >= ctx.threshold,
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
    profileName: play.profile.profileName ?? null,
    profileId: ctx.profileId,
    playerName: (deviceName || row.client_name || '').slice(0, 255) || null,
    device: normalized.device.slice(0, 255),
    deviceId: row.device_id,
    product: row.client_name?.slice(0, 255) || null,
    platform: normalized.platform.slice(0, 100),
    quality: isTranscode ? 'Transcode' : 'Direct',
    isTranscode,
    videoDecision,
    audioDecision,
    bitrate: null,
  };
}

async function siloHistory(
  serverId: string,
  endedAfter: Date | null,
  onNewest: (endedAt: string) => void
): Promise<ServerHistory<SiloHistoryEntry>> {
  const server = await historyServerRow(serverId, 'silo');
  const client = new SiloClient({ url: server.url, token: server.token, id: server.id });
  return {
    server,
    label: 'SiloHistory',
    async *pages(beforeFetch) {
      let cursor: string | null = null;
      do {
        beforeFetch();
        const page = await client.getPlaybackHistoryPage(endedAfter, cursor);
        const [newest] = page.items;
        if (!newest) return;
        if (cursor === null) onNewest(newest.ended_at);
        const names = await client.getDeviceNames(
          page.items.flatMap((row) => (row.device_id ? [row.device_id] : []))
        );
        yield page.items.map((row) => ({
          row,
          deviceName: row.device_id ? names.get(row.device_id) : undefined,
        }));
        cursor = page.page?.has_more ? (page.page.next_cursor ?? null) : null;
      } while (cursor);
    },
    play: siloHistoryPlay,
    toSession: transformSiloHistoryRow,
  };
}

/**
 * Syncs the server's users first, so the import never relies on a sync that ran before it. A
 * first run reads all of Silo's history; a later one reads from an hour before the newest
 * ended_at the last run without a failed play or an unknown account read. A re-run adds what
 * Tracearr does not have and changes no play already in Tracearr.
 */
export async function importSiloHistory(
  serverId: string,
  pubSubService?: PubSubService,
  onProgress?: (progress: ServerHistoryImportProgress) => Promise<void>
): Promise<ServerHistoryImportResult> {
  const redis = getRedis();
  const cursorKey = REDIS_KEYS.SERVER_HISTORY_CURSOR(serverId);
  const stored = await redis.get(cursorKey);
  const storedAt = stored ? Date.parse(stored) : NaN;
  const endedAfter = Number.isFinite(storedAt) ? new Date(storedAt - CURSOR_OVERLAP_MS) : null;
  let newest: string | null = null;
  const result = await importServerHistory(
    serverId,
    () =>
      siloHistory(serverId, endedAfter, (endedAt) => {
        newest ??= endedAt;
      }),
    pubSubService,
    onProgress
  );
  if (newest !== null && result.errors === 0 && result.skippedUsers === undefined) {
    await redis.set(cursorKey, newest);
  }
  return result;
}
