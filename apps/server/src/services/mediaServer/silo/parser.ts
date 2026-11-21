/**
 * Silo API Response Parser
 *
 * Pure functions turning Silo /api/v2 responses into Tracearr's media server types.
 */

import {
  normalizeDynamicRange,
  normalizeResolution,
  type ServerResourceDataPoint,
  type SubtitleInfo,
} from '@tracearr/shared';
import { sanitizeCodec } from '../../../utils/codecNormalizer.js';
import { normalizeStreamDecisions } from '../../../utils/transcodeNormalizer.js';
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
  SiloLibrary,
  SiloProfile,
  SiloSession,
  SiloSubtitle,
  SiloSystemResources,
  SiloUser,
} from './types.js';

export function parseSiloUsers(users: SiloUser[]): MediaUser[] {
  return users.map((user) => ({
    id: user.id,
    username: user.username,
    email: user.email || undefined,
    isAdmin: user.role === 'admin',
    isDisabled: !user.enabled,
    sharedLibraries: user.effective_policy.library_ids ?? undefined,
    lastActivityAt: user.last_active_at ? new Date(user.last_active_at) : undefined,
  }));
}

export function parseSiloProfiles(profiles: SiloProfile[]): MediaProfile[] {
  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    thumb: null,
    isPrimary: profile.is_primary,
    isChild: profile.is_child,
  }));
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

/**
 * Silo's artwork links are signed and expire, so only the content id and the artwork's content
 * hash are stored. A URL outside Silo's API, as an older build gave, stores no path.
 */
export function siloPosterPath(
  contentId: string,
  posterUrl: string | null | undefined
): string | undefined {
  if (!posterUrl?.startsWith('/api/v2/') || !isContentId(contentId)) return undefined;
  const hash = POSTER_HASH.exec(posterUrl)?.[1];
  return `/content/${contentId}/poster${hash ? `?v=${hash}` : ''}`;
}

/** The content id of a stored poster path, or null for any other path */
export function parseSiloPosterPath(path: string): string | null {
  const id = STORED_POSTER.exec(path)?.[1];
  return id && isContentId(id) ? id : null;
}

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
const decisionOf = (decision: string | undefined) => (decision === 'remux' ? 'copy' : decision);

function mediaTypeOf(type: string): 'movie' | 'episode' | 'unknown' {
  switch (type) {
    case 'movie':
    case 'episode':
      return type;
    default:
      return 'unknown';
  }
}

/** A row of /admin/sessions; the player is named after its device where the device list names it */
export function parseSiloSession(row: SiloSession, deviceName: string | undefined): MediaSession {
  const mediaType = mediaTypeOf(row.media_type);
  const thumbPath = row.media_item_id
    ? siloPosterPath(row.media_item_id, row.poster_url)
    : undefined;
  const positionMs = Math.round(row.position_seconds * 1000);
  const durationMs = (row.file_duration ?? 0) * 1000;

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
      ...normalizeStreamDecisions(decisionOf(row.video_decision), decisionOf(row.audio_decision)),
      videoHeight: row.source_video_height,
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
      streamVideoDetails: { bitrate: row.target_bitrate_kbps ?? undefined },
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

/** Silo's CPU seconds at one sample: the cgroup counter, which counts its transcoders, else the process's own */
export interface SiloCpuCounter {
  sampledAt: number;
  cpuSeconds: number;
  source: 'cgroup' | 'process';
  /** The cgroup's scope, leaf or ancestor */
  scope?: string;
}

/** Silo leaves the cgroup counter out of a sample whose cgroup read failed */
export function siloCpuCounter(body: SiloSystemResources): SiloCpuCounter | null {
  if (!body.available || body.stale || !body.sampled_at) return null;
  const sampledAt = Date.parse(body.sampled_at);
  const cgroup = body.attribution?.cgroup_cpu;
  if (typeof cgroup?.usage_seconds === 'number') {
    return { sampledAt, cpuSeconds: cgroup.usage_seconds, source: 'cgroup', scope: cgroup.scope };
  }
  const processSeconds = body.attribution?.process?.cpu_seconds;
  return typeof processSeconds === 'number'
    ? { sampledAt, cpuSeconds: processSeconds, source: 'process' }
    : null;
}

/**
 * One point per new Silo sample. Silo's CPU share is its counter's rise since the previous
 * sample, so the first sample, the same sample read again, a counter that went back (Silo
 * restarted) and a counter other than the previous one add none. mem_total_mb is MiB.
 */
export function parseSiloResources(
  body: SiloSystemResources,
  previous: SiloCpuCounter | undefined
): Omit<ServerResourceDataPoint, 'timespan'> | null {
  const counter = siloCpuCounter(body);
  const { system } = body;
  const residentBytes = body.attribution?.process?.resident_bytes;
  if (
    !counter ||
    !system ||
    residentBytes === undefined ||
    !previous ||
    counter.source !== previous.source ||
    counter.scope !== previous.scope ||
    counter.sampledAt <= previous.sampledAt ||
    counter.cpuSeconds < previous.cpuSeconds
  ) {
    return null;
  }
  const elapsedSeconds = (counter.sampledAt - previous.sampledAt) / 1000;
  const childrenBytes = body.attribution?.children?.resident_bytes ?? 0;
  return {
    at: Math.floor(counter.sampledAt / 1000),
    hostCpuUtilization: system.cpu_pct,
    hostMemoryUtilization: (system.mem_used_mb / system.mem_total_mb) * 100,
    processCpuUtilization:
      ((counter.cpuSeconds - previous.cpuSeconds) / (elapsedSeconds * system.cores)) * 100,
    processMemoryUtilization:
      ((residentBytes + childrenBytes) / (system.mem_total_mb * 1024 * 1024)) * 100,
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
