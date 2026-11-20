/**
 * Session factory for test data generation
 *
 * Creates session entities for stream tracking.
 */

import { executeRawSql } from '../db/pool.js';

export type SessionState = 'playing' | 'paused' | 'stopped';
export type MediaType = 'movie' | 'episode' | 'track';

export interface SessionData {
  id?: string;
  serverId: string;
  serverUserId: string;
  sessionKey?: string;
  state?: SessionState;
  mediaType?: MediaType;
  mediaTitle?: string;
  grandparentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
  thumbPath?: string | null;
  ratingKey?: string | null;
  parentRatingKey?: string | null;
  grandparentRatingKey?: string | null;
  mediaId?: string | null;
  showMediaId?: string | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
  shortSession?: boolean;
  externalSessionId?: string | null;
  startedAt?: Date;
  stoppedAt?: Date | null;
  lastSeenAt?: Date;
  durationMs?: number | null;
  totalDurationMs?: number | null;
  progressMs?: number | null;
  lastPausedAt?: Date | null;
  pausedDurationMs?: number;
  referenceId?: string | null;
  watched?: boolean;
  ipAddress?: string;
  geoCity?: string | null;
  geoRegion?: string | null;
  geoCountry?: string | null;
  geoLat?: number | null;
  geoLon?: number | null;
  geoAsnNumber?: number | null;
  geoAsnOrganization?: string | null;
  profileId?: string | null;
  profileName?: string | null;
  playerName?: string | null;
  deviceId?: string | null;
  product?: string | null;
  device?: string | null;
  platform?: string | null;
  quality?: string | null;
  isTranscode?: boolean;
  bitrate?: number | null;
}

export interface CreatedSession {
  id: string;
  serverId: string;
  serverUserId: string;
  sessionKey: string;
  state: SessionState;
  mediaType: MediaType;
  mediaTitle: string;
  ipAddress: string;
  startedAt: Date;
  // Additional fields omitted for brevity
}

let sessionCounter = 0;

/**
 * Generate unique session data with defaults
 */
export function buildSession(overrides: SessionData): Required<SessionData> {
  const index = ++sessionCounter;
  const now = new Date();

  return {
    id: overrides.id ?? crypto.randomUUID(),
    serverId: overrides.serverId,
    serverUserId: overrides.serverUserId,
    sessionKey: overrides.sessionKey ?? `session-${index}`,
    state: overrides.state ?? 'playing',
    mediaType: overrides.mediaType ?? 'movie',
    mediaTitle: overrides.mediaTitle ?? `Test Movie ${index}`,
    grandparentTitle: overrides.grandparentTitle ?? null,
    seasonNumber: overrides.seasonNumber ?? null,
    episodeNumber: overrides.episodeNumber ?? null,
    year: overrides.year ?? 2024,
    thumbPath: overrides.thumbPath ?? null,
    ratingKey: overrides.ratingKey ?? `ratingkey-${index}`,
    parentRatingKey: overrides.parentRatingKey ?? null,
    grandparentRatingKey: overrides.grandparentRatingKey ?? null,
    mediaId: overrides.mediaId ?? null,
    showMediaId: overrides.showMediaId ?? null,
    imdbId: overrides.imdbId ?? null,
    tmdbId: overrides.tmdbId ?? null,
    tvdbId: overrides.tvdbId ?? null,
    shortSession: overrides.shortSession ?? false,
    externalSessionId: overrides.externalSessionId ?? null,
    startedAt: overrides.startedAt ?? now,
    stoppedAt: overrides.stoppedAt ?? null,
    lastSeenAt: overrides.lastSeenAt ?? overrides.stoppedAt ?? now,
    durationMs: overrides.durationMs ?? null,
    totalDurationMs: overrides.totalDurationMs ?? 7200000, // 2 hours
    progressMs: overrides.progressMs ?? 0,
    lastPausedAt: overrides.lastPausedAt ?? null,
    pausedDurationMs: overrides.pausedDurationMs ?? 0,
    referenceId: overrides.referenceId ?? null,
    watched: overrides.watched ?? false,
    ipAddress: overrides.ipAddress ?? `192.168.1.${100 + (index % 155)}`,
    geoCity: overrides.geoCity ?? 'New York',
    geoRegion: overrides.geoRegion ?? 'NY',
    geoCountry: overrides.geoCountry ?? 'US',
    geoLat: overrides.geoLat ?? 40.7128,
    geoLon: overrides.geoLon ?? -74.006,
    geoAsnNumber: overrides.geoAsnNumber ?? 7922,
    geoAsnOrganization: overrides.geoAsnOrganization ?? 'Comcast Cable Communications, LLC',
    profileId: overrides.profileId ?? null,
    profileName: overrides.profileName ?? null,
    playerName: overrides.playerName ?? `Player ${index}`,
    deviceId: overrides.deviceId ?? `device-${index}`,
    product: overrides.product ?? 'Plex Web',
    device: overrides.device ?? 'Chrome',
    platform: overrides.platform ?? 'Web',
    quality: overrides.quality ?? '1080p',
    isTranscode: overrides.isTranscode ?? false,
    bitrate: overrides.bitrate ?? 20000,
  };
}

/**
 * Create a session in the database
 */
export async function createTestSession(data: SessionData): Promise<CreatedSession> {
  const fullData = buildSession(data);

  const result = await executeRawSql(`
    INSERT INTO sessions (
      id, server_id, server_user_id, session_key, state, media_type,
      media_title, grandparent_title, season_number, episode_number,
      year, thumb_path, rating_key, parent_rating_key, grandparent_rating_key,
      media_id, show_media_id, imdb_id, tmdb_id, tvdb_id,
      external_session_id,
      started_at, stopped_at, last_seen_at, duration_ms, total_duration_ms, progress_ms,
      last_paused_at, paused_duration_ms, reference_id, watched, short_session,
      ip_address, geo_city, geo_region, geo_country, geo_lat, geo_lon,
      geo_asn_number, geo_asn_organization, profile_id, profile_name,
      player_name, device_id, product, device, platform,
      quality, is_transcode, bitrate
    ) VALUES (
      '${fullData.id}',
      '${fullData.serverId}',
      '${fullData.serverUserId}',
      '${fullData.sessionKey}',
      '${fullData.state}',
      '${fullData.mediaType}',
      '${fullData.mediaTitle}',
      ${fullData.grandparentTitle ? `'${fullData.grandparentTitle}'` : 'NULL'},
      ${fullData.seasonNumber ?? 'NULL'},
      ${fullData.episodeNumber ?? 'NULL'},
      ${fullData.year ?? 'NULL'},
      ${fullData.thumbPath ? `'${fullData.thumbPath}'` : 'NULL'},
      ${fullData.ratingKey ? `'${fullData.ratingKey}'` : 'NULL'},
      ${fullData.parentRatingKey ? `'${fullData.parentRatingKey}'` : 'NULL'},
      ${fullData.grandparentRatingKey ? `'${fullData.grandparentRatingKey}'` : 'NULL'},
      ${fullData.mediaId ? `'${fullData.mediaId}'` : 'NULL'},
      ${fullData.showMediaId ? `'${fullData.showMediaId}'` : 'NULL'},
      ${fullData.imdbId ? `'${fullData.imdbId}'` : 'NULL'},
      ${fullData.tmdbId ?? 'NULL'},
      ${fullData.tvdbId ?? 'NULL'},
      ${fullData.externalSessionId ? `'${fullData.externalSessionId}'` : 'NULL'},
      '${fullData.startedAt.toISOString()}',
      ${fullData.stoppedAt ? `'${fullData.stoppedAt.toISOString()}'` : 'NULL'},
      '${fullData.lastSeenAt.toISOString()}',
      ${fullData.durationMs ?? 'NULL'},
      ${fullData.totalDurationMs ?? 'NULL'},
      ${fullData.progressMs ?? 'NULL'},
      ${fullData.lastPausedAt ? `'${fullData.lastPausedAt.toISOString()}'` : 'NULL'},
      ${fullData.pausedDurationMs},
      ${fullData.referenceId ? `'${fullData.referenceId}'` : 'NULL'},
      ${fullData.watched},
      ${fullData.shortSession},
      '${fullData.ipAddress}',
      ${fullData.geoCity ? `'${fullData.geoCity}'` : 'NULL'},
      ${fullData.geoRegion ? `'${fullData.geoRegion}'` : 'NULL'},
      ${fullData.geoCountry ? `'${fullData.geoCountry}'` : 'NULL'},
      ${fullData.geoLat ?? 'NULL'},
      ${fullData.geoLon ?? 'NULL'},
      ${fullData.geoAsnNumber ?? 'NULL'},
      ${fullData.geoAsnOrganization ? `'${fullData.geoAsnOrganization}'` : 'NULL'},
      ${fullData.profileId ? `'${fullData.profileId}'` : 'NULL'},
      ${fullData.profileName ? `'${fullData.profileName}'` : 'NULL'},
      ${fullData.playerName ? `'${fullData.playerName}'` : 'NULL'},
      ${fullData.deviceId ? `'${fullData.deviceId}'` : 'NULL'},
      ${fullData.product ? `'${fullData.product}'` : 'NULL'},
      ${fullData.device ? `'${fullData.device}'` : 'NULL'},
      ${fullData.platform ? `'${fullData.platform}'` : 'NULL'},
      ${fullData.quality ? `'${fullData.quality}'` : 'NULL'},
      ${fullData.isTranscode},
      ${fullData.bitrate ?? 'NULL'}
    )
    RETURNING *
  `);

  return mapSessionRow(result.rows[0]);
}

/**
 * Create an active (playing) session
 */
export async function createActiveSession(data: SessionData): Promise<CreatedSession> {
  return createTestSession({
    ...data,
    state: 'playing',
    stoppedAt: null,
  });
}

/**
 * Create a paused session
 */
export async function createPausedSession(data: SessionData): Promise<CreatedSession> {
  return createTestSession({
    ...data,
    state: 'paused',
    lastPausedAt: data.lastPausedAt ?? new Date(),
    stoppedAt: null,
  });
}

/**
 * Create a stopped session
 */
export async function createStoppedSession(data: SessionData): Promise<CreatedSession> {
  const now = new Date();
  return createTestSession({
    ...data,
    state: 'stopped',
    stoppedAt: data.stoppedAt ?? now,
    durationMs: data.durationMs ?? 3600000, // 1 hour watched
  });
}

/**
 * Create an episode session
 */
export async function createEpisodeSession(data: SessionData): Promise<CreatedSession> {
  return createTestSession({
    ...data,
    mediaType: 'episode',
    grandparentTitle: data.grandparentTitle ?? 'Test TV Show',
    seasonNumber: data.seasonNumber ?? 1,
    episodeNumber: data.episodeNumber ?? 1,
    mediaTitle: data.mediaTitle ?? 'Pilot',
  });
}

/**
 * Create multiple sessions for testing concurrent streams
 */
export async function createConcurrentSessions(
  count: number,
  data: SessionData
): Promise<CreatedSession[]> {
  const sessions: CreatedSession[] = [];
  for (let i = 0; i < count; i++) {
    sessions.push(
      await createActiveSession({
        ...data,
        deviceId: `device-${i + 1}`,
        ipAddress: `192.168.1.${100 + i}`,
      })
    );
  }
  return sessions;
}

/**
 * Map database row to typed session object
 */
function mapSessionRow(row: Record<string, unknown>): CreatedSession {
  return {
    id: row.id as string,
    serverId: row.server_id as string,
    serverUserId: row.server_user_id as string,
    sessionKey: row.session_key as string,
    state: row.state as SessionState,
    mediaType: row.media_type as MediaType,
    mediaTitle: row.media_title as string,
    ipAddress: row.ip_address as string,
    startedAt: row.started_at as Date,
  };
}

/**
 * Reset session counter
 */
export function resetSessionCounter(): void {
  sessionCounter = 0;
}
