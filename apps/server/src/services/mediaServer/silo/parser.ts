/**
 * Silo API Response Parser
 *
 * Pure functions turning Silo /api/v2 responses into Tracearr's media server types.
 */

import {
  normalizeDynamicRange,
  normalizeResolution,
  SERVER_PROFILES,
  type ServerResourceDataPoint,
  type SubtitleInfo,
} from '@tracearr/shared';
import { sanitizeCodec } from '../../../utils/codecNormalizer.js';
import {
  normalizeStreamDecisions,
  type StreamDecisions,
} from '../../../utils/transcodeNormalizer.js';
import type { ProfileNaming } from '../../profiles.js';
import { calculateProgress } from '../shared/parserUtils.js';
import { rollupVersions } from '../shared/versionUtils.js';
import type {
  DownloadSourceDescription,
  DownloadSourceRequest,
  MediaItemVersion,
  MediaLibrary,
  MediaLibraryItem,
  MediaProfile,
  MediaSession,
  MediaUser,
} from '../types.js';
import type {
  SiloCatalogItem,
  SiloCatalogVersion,
  SiloDevice,
  SiloDownloadEntry,
  SiloHistoryRow,
  SiloLibrary,
  SiloProfile,
  SiloSession,
  SiloSubtitle,
  SiloSystemResources,
  SiloUser,
} from './types.js';

/**
 * An account shows its primary profile's picture; profiles null means they could not be read,
 * so the stored pictures stay
 */
export function parseSiloUsers(
  users: SiloUser[],
  profiles: ReadonlyMap<string, SiloProfile[]> | null
): MediaUser[] {
  return users.map((user) => {
    const primary = profiles?.get(user.id)?.find((profile) => profile.is_primary);
    return {
      id: user.id,
      username: user.username,
      email: user.email || undefined,
      isAdmin: user.role === 'admin',
      isDisabled: !user.enabled,
      sharedLibraries: user.effective_policy.library_ids ?? undefined,
      lastActivityAt: user.last_active_at ? new Date(user.last_active_at) : undefined,
      joinedAt: new Date(user.created_at),
      ...(profiles
        ? { thumb: primary ? profilePicture(user.id, primary) : null }
        : { picturesUnread: true }),
    };
  });
}

export function parseSiloProfiles(profiles: SiloProfile[], accountId: string): MediaProfile[] {
  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    thumb: profilePicture(accountId, profile),
    isPrimary: profile.is_primary,
    isChild: profile.is_child,
  }));
}

/** One of the avatars bundled with Silo's web app, served from the server's origin without a key */
export const SILO_PRESET_AVATAR_PATH = /^\/profile-avatars\/[\w-]+\.svg$/;
const STORED_AVATAR = /^\/users\/([\w-]+)\/profiles\/([\w-]+)\/avatar$/;

/**
 * Where an uploaded avatar is filed: Silo's link to it is signed for minutes, so the account and
 * profile are stored and the link is read again when the picture is fetched
 */
function siloAvatarPath(accountId: string, profileId: string): string | null {
  const path = `/users/${accountId}/profiles/${profileId}/avatar`;
  return STORED_AVATAR.test(path) ? path : null;
}

/** The account and profile of a stored upload path, or null for any other path */
export function parseSiloAvatarPath(path: string): { accountId: string; profileId: string } | null {
  const [, accountId, profileId] = STORED_AVATAR.exec(path) ?? [];
  return accountId && profileId ? { accountId, profileId } : null;
}

/** A DiceBear preset, fetched from its host as guide art is */
function isAvatarHostUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' && SERVER_PROFILES.silo.guideImageHosts.includes(hostname);
}

/** A preset as Silo links it, an upload on Silo's own API by its stored path, else none */
function profilePicture(accountId: string, profile: SiloProfile): string | null {
  const url = profile.avatar_url;
  if (!url) return null;
  switch (profile.avatar_source) {
    case 'preset':
      return SILO_PRESET_AVATAR_PATH.test(url) || isAvatarHostUrl(url) ? url : null;
    case 'upload':
      return url.startsWith('/api/v2/') ? siloAvatarPath(accountId, profile.id) : null;
    default:
      return null;
  }
}

export function parseSiloLibraries(libraries: SiloLibrary[]): MediaLibrary[] {
  return libraries.map((library) => ({
    id: library.id,
    name: library.name,
    type: library.type === 'series' ? 'show' : library.type,
  }));
}

export function parseSiloDeviceNames(devices: SiloDevice[]): Map<string, string> {
  return new Map(devices.map((device) => [device.device_id, device.device_name]));
}

const CONTENT_ID = /^[A-Za-z0-9._-]+$/;
const POSTER_HASH = /\/[^/?#]*\.([0-9a-f]{8,128})\.[a-z0-9]+(?:\?|$)/;
const STORED_POSTER = /^\/content\/([A-Za-z0-9._-]+)\/poster(?:\?v=[0-9a-f]{8,128})?$/;

const isContentId = (id: string) => CONTENT_ID.test(id) && id !== '.' && id !== '..';

/** The stored poster path of an item, unversioned; undefined for an id that is not a safe content id */
export function siloItemPosterPath(contentId: string): string | undefined {
  return isContentId(contentId) ? `/content/${contentId}/poster` : undefined;
}

/**
 * Silo's artwork links are signed and expire, so only the content id and the artwork's content
 * hash are stored. A URL outside Silo's API, as an older build gave, stores no path.
 */
export function siloPosterPath(
  contentId: string,
  posterUrl: string | null | undefined
): string | undefined {
  const path = siloItemPosterPath(contentId);
  if (!posterUrl?.startsWith('/api/v2/') || !path) return undefined;
  const hash = POSTER_HASH.exec(posterUrl)?.[1];
  return hash ? `${path}?v=${hash}` : path;
}

/** The content id of a stored poster path, or null for any other path */
export function parseSiloPosterPath(path: string): string | null {
  const id = STORED_POSTER.exec(path)?.[1];
  return id && isContentId(id) ? id : null;
}

/** A request's poster on Silo, fetched with the key */
export const SILO_REQUEST_POSTER_PATH = /^\/api\/v2\/admin\/requests\/[\w-]+\/poster$/;

/** Silo lists no seasons, so a season is keyed by its series and number */
export function siloSeasonKey(seriesId: string, season: number): string {
  return `${seriesId}/season/${season}`;
}

function subtitleOf(subtitle: SiloSubtitle): SubtitleInfo {
  return {
    codec: subtitle.codec?.toUpperCase(),
    language: subtitle.language ?? undefined,
    forced: subtitle.forced || undefined,
    decision: subtitle.delivery === 'burn_in' ? 'burn' : undefined,
  };
}

/** Silo's remux keeps the stream as it is in a new container, which Tracearr calls copy */
const decisionOf = (decision: string | null | undefined) =>
  decision === 'remux' ? 'copy' : decision;

/** How Silo delivered video and audio, remux read as copy, for live rows and history alike */
export function siloStreamDecisions(
  video: string | null | undefined,
  audio: string | null | undefined
): StreamDecisions {
  return normalizeStreamDecisions(decisionOf(video), decisionOf(audio));
}

/** The account and profile a history row names; a profile Silo recorded no name for is left unnamed */
export function siloHistoryProfileNaming(row: SiloHistoryRow): ProfileNaming {
  return {
    accountExternalId: row.user_id,
    profileExternalId: row.profile_id || null,
    profileName: row.profile_name && row.profile_name !== row.profile_id ? row.profile_name : null,
  };
}

/** Time watched as Silo's history page shows it: the measurement, else the end position capped at the time from start to end */
export function siloWatchedSeconds(row: SiloHistoryRow): number {
  if (row.played_seconds !== null) return row.played_seconds;
  const elapsed = (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000;
  const capped = Number.isFinite(elapsed)
    ? Math.min(row.end_position_seconds, Math.max(elapsed, 0))
    : row.end_position_seconds;
  return Math.max(capped, 0);
}

export function siloMediaType(type: string): 'movie' | 'episode' | 'unknown' {
  switch (type) {
    case 'movie':
    case 'episode':
      return type;
    default:
      return 'unknown';
  }
}

/** The line count of a Silo size label such as 1080p */
const labelLines = (label: string | undefined) => {
  const lines = /^(\d+)p$/i.exec(label?.trim() ?? '')?.[1];
  return lines ? Number(lines) : undefined;
};

/**
 * The heights a Silo play is classified by. Silo files a source by its size class (a 1920x800
 * film is 1080p), so the label's line count stands in for the height, which is the fallback.
 * Copied video goes out at the source's size. A transcode target names the output height, and
 * one equal to the source's pixel height keeps the source's class, as Silo's own pages show it.
 */
function siloVideoHeights(row: SiloSession): { source?: number; stream?: number } {
  const source = labelLines(row.source_video_resolution) ?? row.source_video_height;
  if (row.video_decision !== 'transcode') return { source, stream: source };
  const target = labelLines(row.target_resolution);
  return {
    source,
    stream: target !== undefined && target === row.source_video_height ? source : target,
  };
}

/** A row of /admin/sessions; the player is named after its device where the device list names it */
export function parseSiloSession(row: SiloSession, deviceName: string | undefined): MediaSession {
  const mediaType = siloMediaType(row.media_type);
  const thumbPath = row.media_item_id
    ? siloPosterPath(row.media_item_id, row.poster_url)
    : undefined;
  const positionMs = Math.round(row.position_seconds * 1000);
  const durationMs = (row.file_duration ?? 0) * 1000;
  const heights = siloVideoHeights(row);

  return {
    sessionKey: row.session_id,
    mediaId: row.media_item_id ?? '',
    serverVersionKey: row.media_file_id,
    user: {
      id: row.user_id,
      username: row.username,
      profileId: row.profile_id || undefined,
      profileName: row.profile_name || undefined,
    },
    media: { title: row.media_title, type: mediaType, durationMs, thumbPath },
    episode:
      mediaType === 'episode'
        ? {
            showTitle: row.series_title ?? '',
            seasonNumber: row.season_number ?? null,
            episodeNumber: row.episode_number ?? null,
            showThumbPath: thumbPath,
          }
        : undefined,
    playback: {
      state: row.is_paused ? 'paused' : 'playing',
      positionMs,
      progressPercent: calculateProgress(positionMs, durationMs),
    },
    player: {
      name: deviceName || row.client_name || '',
      deviceId: row.device_id ?? '',
      product: row.client_name || undefined,
      platform: row.device_platform || undefined,
    },
    network: { ipAddress: row.client_ip ?? '', isLocal: row.stream_location === 'local' },
    quality: {
      bitrate: row.stream_bitrate_kbps ?? row.source_bitrate_kbps ?? 0,
      ...siloStreamDecisions(row.video_decision, row.audio_decision),
      videoHeight: heights.source,
      sourceVideoCodec: sanitizeCodec(row.source_video_codec) ?? undefined,
      sourceAudioCodec: sanitizeCodec(row.source_audio_codec) ?? undefined,
      sourceAudioChannels: row.source_audio_channels ?? undefined,
      sourceVideoDetails: { bitrate: row.source_bitrate_kbps ?? undefined },
      sourceAudioDetails: {
        channelLayout: row.source_audio_layout || undefined,
        language: row.source_audio_language || undefined,
      },
      // A remux names no target video codec: the source's is sent
      streamVideoCodec:
        sanitizeCodec(row.target_video_codec || row.source_video_codec) ?? undefined,
      streamAudioCodec:
        sanitizeCodec(row.target_audio_codec || row.source_audio_codec) ?? undefined,
      streamVideoDetails: {
        bitrate: row.target_bitrate_kbps ?? undefined,
        height: heights.stream,
      },
      streamAudioDetails: { channels: row.target_audio_channels },
      transcodeInfo: {
        hwEncoding: row.transcode_hw_accel || undefined,
        reasons: row.adaptation_reasons,
        sourceContainer: row.source_container || undefined,
        streamContainer: row.output_container || undefined,
      },
      subtitleInfo: row.subtitle ? subtitleOf(row.subtitle) : undefined,
    },
  };
}

const DYNAMIC_RANGES: Record<string, string> = {
  sdr: 'SDR',
  hdr10: 'HDR10',
  hdr10_plus: 'HDR10+',
  hlg: 'HLG',
  dolby_vision: 'Dolby Vision',
  hdr_unknown: 'HDR',
};

function fileVersion(file: SiloCatalogVersion): MediaItemVersion {
  return {
    serverVersionKey: file.file_id,
    videoResolution: normalizeResolution({ label: file.resolution })?.toLowerCase(),
    videoCodec: file.codec_video?.toUpperCase(),
    videoDynamicRange:
      normalizeDynamicRange(file.dynamic_range && DYNAMIC_RANGES[file.dynamic_range]) ?? undefined,
    audioCodec: file.codec_audio?.toUpperCase(),
    audioChannels: file.audio_channels,
    audioAtmos: file.atmos,
    editionTitle: file.edition,
    container: file.container?.toLowerCase(),
    bitrate: file.bitrate_kbps,
    fileSize: file.file_size,
    partCount: 1,
  };
}

function providerId(id: string | undefined): number | undefined {
  const value = Number(id);
  return id && Number.isFinite(value) ? value : undefined;
}

export interface SiloLibraryListing {
  items: MediaLibraryItem[];
  episodes: MediaLibraryItem[];
  seasons: MediaLibraryItem[];
}

/**
 * A library's catalog: movies and series as items, episodes as leaves, and seasons built from
 * the episodes, since Silo lists none. An episode shows its series' poster, which Silo gives it,
 * so its stored path is the series' and a show's episodes share one cached poster. An item in
 * several libraries carries only this library's files.
 */
export function parseSiloLibraryListing(
  catalog: SiloCatalogItem[],
  libraryId: string
): SiloLibraryListing {
  const items: MediaLibraryItem[] = [];
  const episodes: MediaLibraryItem[] = [];
  const seasons = new Map<string, MediaLibraryItem>();

  for (const entry of catalog) {
    const base: MediaLibraryItem = {
      ratingKey: entry.content_id,
      title: entry.title,
      mediaType: 'movie',
      year: entry.year,
      addedAt: new Date(entry.added_at),
      imdbId: entry.imdb_id || undefined,
      tmdbId: providerId(entry.tmdb_id),
      tvdbId: providerId(entry.tvdb_id),
      genres: entry.genres?.length ? entry.genres : undefined,
    };
    const files = () =>
      rollupVersions(
        entry.versions.filter((file) => file.library_id === libraryId).map(fileVersion)
      );

    switch (entry.type) {
      case 'movie':
        items.push({
          ...base,
          thumbPath: siloPosterPath(entry.content_id, entry.poster_url),
          ...files(),
        });
        break;
      case 'series':
        items.push({
          ...base,
          mediaType: 'show',
          thumbPath: siloPosterPath(entry.content_id, entry.poster_url),
        });
        break;
      case 'episode': {
        const { series_id: seriesId, season_number: season } = entry;
        const thumbPath = seriesId ? siloPosterPath(seriesId, entry.poster_url) : undefined;
        const seasonKey =
          seriesId !== undefined && season !== undefined
            ? siloSeasonKey(seriesId, season)
            : undefined;
        const episode: MediaLibraryItem = {
          ...base,
          mediaType: 'episode',
          thumbPath,
          grandparentRatingKey: seriesId,
          grandparentTitle: entry.series_title,
          parentRatingKey: seasonKey,
          parentTitle: season !== undefined ? `Season ${season}` : undefined,
          parentIndex: season,
          itemIndex: entry.episode_number,
          ...files(),
        };
        episodes.push(episode);
        if (seasonKey === undefined || season === undefined) break;
        const held = seasons.get(seasonKey);
        if (!held) {
          seasons.set(seasonKey, {
            ratingKey: seasonKey,
            title: `Season ${season}`,
            mediaType: 'season',
            addedAt: episode.addedAt,
            parentTitle: entry.series_title,
            parentRatingKey: seriesId,
            parentIndex: season,
            thumbPath,
          });
        } else if (episode.addedAt < held.addedAt) {
          held.addedAt = episode.addedAt;
        }
        break;
      }
      default:
        break;
    }
  }

  return { items, episodes, seasons: [...seasons.values()] };
}

/**
 * Silo's latest resource sample as its own dashboard shows it: the CPU busy share it measured
 * over the last interval, memory used of total, and the Silo process's resident memory, which
 * Silo keeps apart from its transcoders'. Silo shows no CPU share for its own process, so none
 * is charted. A stale or unavailable sample is not zero load, and a reading Silo marks
 * unavailable is left out. mem_total_mb is MiB.
 */
export function parseSiloResources(
  body: SiloSystemResources
): Omit<ServerResourceDataPoint, 'timespan'> | null {
  const { system, attribution } = body;
  const sampledAt = Date.parse(body.sampled_at ?? '');
  const residentBytes = attribution?.process?.resident_bytes;
  if (
    !body.available ||
    body.stale ||
    !Number.isFinite(sampledAt) ||
    !system ||
    !(system.mem_total_mb > 0) ||
    residentBytes === undefined
  ) {
    return null;
  }
  return {
    at: Math.floor(sampledAt / 1000),
    hostCpuUtilization: attribution?.cpu?.available === false ? null : system.cpu_pct,
    hostMemoryUtilization:
      attribution?.memory?.available === false
        ? null
        : (system.mem_used_mb / system.mem_total_mb) * 100,
    processCpuUtilization: null,
    processMemoryUtilization: (residentBytes / (system.mem_total_mb * 1024 * 1024)) * 100,
  };
}

/**
 * A download as Silo listed it: what it sent, and the address it was created from, else its last.
 * An entry names no file, so no version is described.
 */
export function parseSiloDownloadSource(
  request: DownloadSourceRequest,
  entry: SiloDownloadEntry | undefined
): DownloadSourceDescription {
  return {
    version: null,
    delivered: entry
      ? {
          bytes: entry.file_size || null,
          videoCodec: null,
          audioCodec: null,
          container: null,
          bitrateKbps: entry.target_bitrate_kbps || null,
          resolution: null,
        }
      : null,
    device: {
      deviceId: request.deviceId,
      playerName: entry?.device_name || request.device,
      product: request.app,
      platform: null,
    },
    ipAddress: entry ? (entry.created_client_ip ?? entry.last_client_ip) : null,
  };
}
