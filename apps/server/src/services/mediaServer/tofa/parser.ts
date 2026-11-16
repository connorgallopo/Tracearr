/**
 * tofa API Response Parser
 *
 * Pure functions turning tofa API responses into Tracearr's media server types.
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
import { calculateProgress } from '../shared/parserUtils.js';
import {
  computeVersionsFingerprint,
  pickBestVersion,
  sumVersionSizes,
} from '../shared/versionUtils.js';
import type {
  DownloadSourceDescription,
  DownloadSourceRequest,
  MediaItemVersion,
  MediaLibrary,
  MediaLibraryItem,
  MediaSession,
  MediaUser,
} from '../types.js';
import type {
  TofaApiKey,
  TofaAccountLink,
  TofaCloudUser,
  TofaDiscoveryDetail,
  TofaDownload,
  TofaKeyScopes,
  TofaLibrary,
  TofaLiveNowPlayingSession,
  TofaLiveViewer,
  TofaMedia,
  TofaMediaDetail,
  TofaMediaFile,
  TofaProfile,
  TofaMetrics,
  TofaNowPlayingSession,
  TofaPlaybackSession,
  TofaSocketFrame,
  TofaStreamEvent,
  TofaUser,
} from './types.js';

/**
 * Library access and the cloud identity come from the cloud user list. A user missing from it
 * has no access Tracearr can see, so it maps to no libraries rather than to all of them, and a
 * user whose cloud access was revoked has no cloud identity to sign in with.
 */
export function parseUsers(
  users: TofaUser[],
  cloudUsers: TofaCloudUser[],
  profiles: TofaProfile[] | null
): MediaUser[] {
  const accessByUser = new Map(cloudUsers.map((cloud) => [cloud.local_user_id, cloud]));
  const profilesRead = profiles !== null;
  const pictureByUser = new Map(
    (profiles ?? []).filter((p) => p.is_primary).map((p) => [p.user_id, profilePicture(p)])
  );
  return users.map((user) => {
    const access = accessByUser.get(user.id);
    return {
      id: user.id,
      username: user.username,
      email: user.email ?? undefined,
      isAdmin: user.is_admin === true,
      isDisabled: user.disabled,
      sharedLibraries: access?.unrestricted_libraries ? undefined : (access?.library_ids ?? []),
      cloudIdentityId: access && !access.revoked_at ? access.cloud_identity_id : null,
      ...(profilesRead ? { thumb: pictureByUser.get(user.id) ?? null } : { picturesUnread: true }),
    };
  });
}

const PRESET_AVATAR_PATH = '/api/v1/profiles/avatars/';

/** An uploaded photo, else the server's bundled image for a preset avatar */
function profilePicture(profile: TofaProfile): string | null {
  if (profile.avatar_image_url) return profile.avatar_image_url;
  const preset = profile.avatar_ref?.match(/^preset:([\w-]+)$/)?.[1];
  return preset ? `${PRESET_AVATAR_PATH}${preset}.png` : null;
}

/** Whether a picture is one profilePicture could have given */
export function isTofaPicture(url: string): boolean {
  return url.startsWith(PRESET_AVATAR_PATH) || isTofaCloudUrl(url);
}

function isTofaCloudUrl(url: string): boolean {
  return URL.canParse(url) && SERVER_PROFILES.tofa.guideImageHosts.includes(new URL(url).hostname);
}

/** An account on another media server that tofa says is one of its users */
export interface TofaLinkedAccount {
  userId: string;
  provider: string;
  externalUserId: string;
  externalServerId: string;
}

/** The links that name both the account and its server; tofa leaves the ids off older links */
export function parseAccountLinks(links: TofaAccountLink[]): TofaLinkedAccount[] {
  return links.flatMap((link) =>
    link.external_user_id && link.external_server_id
      ? [
          {
            userId: link.user_id,
            provider: link.provider,
            externalUserId: link.external_user_id,
            externalServerId: link.external_server_id,
          },
        ]
      : []
  );
}

export function parseLibraries(libraries: TofaLibrary[]): MediaLibrary[] {
  return libraries.map((library) => ({
    id: library.id,
    name: library.name,
    type: library.media_type === 'tv' ? 'show' : library.media_type,
  }));
}

/**
 * The scopes of the key Tracearr calls with, found by its prefix. A full-admin key
 * lists can_stop_streams false and still stops streams.
 */
export function parseKeyScopes(keys: TofaApiKey[], token: string): TofaKeyScopes {
  const key = keys.find((k) => k.revoked_at === null && token.startsWith(k.key_prefix));
  if (!key) throw new Error('tofa did not list the API key Tracearr uses');
  const readOnly = key.read_only === true;
  return { readOnly, canStopStreams: !readOnly || key.can_stop_streams === true };
}

type Decisions = [video: string, audio: string];

/** The video and audio decision each way tofa can deliver a file */
const DECISION_MODES: Record<string, Decisions> = {
  DirectFile: ['directplay', 'directplay'],
  HlsRemux: ['copy', 'copy'],
  HlsCopyVideoTranscodeAudio: ['copy', 'transcode'],
  HlsFullTranscode: ['transcode', 'transcode'],
};

const PLAY_METHODS: Record<string, Decisions> = {
  DirectPlay: ['directplay', 'directplay'],
  DirectStream: ['copy', 'copy'],
  Transcode: ['transcode', 'transcode'],
};

/** The video and audio decisions a play method stands for, where no decision mode says more */
export function playMethodDecisions(playMethod: string): StreamDecisions {
  const [video, audio] = PLAY_METHODS[playMethod] ?? [];
  return normalizeStreamDecisions(video, audio);
}

/** WIDTHxHEIGHT, or a height label such as 1080p, which is read as 16:9 */
function frameSize(resolution: string | null | undefined): { width?: number; height?: number } {
  const dimensions = /^(\d+)x(\d+)$/.exec(resolution ?? '');
  if (dimensions) return { width: Number(dimensions[1]), height: Number(dimensions[2]) };
  const label = /^(\d+)p$/i.exec(resolution ?? '');
  if (!label) return {};
  const height = Number(label[1]);
  return { width: Math.round((height * 16) / 9), height };
}

function yearOf(releaseDate: string | null | undefined): number | null {
  return releaseDate ? Number(releaseDate.slice(0, 4)) : null;
}

/**
 * When a file joined the library. tofa dates it by its modified time, which a release can carry
 * from years before the title came out, so a modified time before the release day, or after tofa
 * first saw the file, gives way to when tofa first saw it.
 */
function fileAddedAt(file: TofaMediaFile, released: string | null | undefined): number {
  const seen = Date.parse(file.created_at);
  const modified = file.file_modified_at ? Date.parse(file.file_modified_at) : NaN;
  const releaseDay = released ? Date.parse(released.slice(0, 10)) : -Infinity;
  return modified >= releaseDay && modified <= seen ? modified : seen;
}

/** An episode's file was released with the episode, any other file with its title */
function fileReleaseDates(
  detail: TofaMediaDetail
): (file: TofaMediaFile) => string | null | undefined {
  const airDates = new Map(
    (detail.seasons ?? []).flatMap((season) =>
      (season.episodes ?? []).map((episode) => [episode.id, episode.air_date])
    )
  );
  return (file) => (file.episode_id ? airDates.get(file.episode_id) : null) ?? detail.release_date;
}

/** The earliest file's date; tofa's own date for a title without files */
function addedDate(
  files: TofaMediaFile[],
  releasedOf: (file: TofaMediaFile) => string | null | undefined,
  fallback?: string | null
): Date {
  const times = files.map((file) => fileAddedAt(file, releasedOf(file)));
  return new Date(times.length > 0 ? Math.min(...times) : fallback ? Date.parse(fallback) : 0);
}

/** Artwork goes through the image proxy, which reads it from the server with the API key */
export function tofaPosterPath(mediaId: string): string {
  return `/api/v1/artwork/${mediaId}/poster`;
}

/** One file as a version of its item */
function fileVersion(file: TofaMediaFile): MediaItemVersion {
  const audio = file.audio_tracks[0];
  return {
    serverVersionKey: file.id,
    videoResolution: normalizeResolution(frameSize(file.resolution))?.toLowerCase(),
    videoCodec: file.video_codec?.toUpperCase(),
    videoDynamicRange:
      normalizeDynamicRange(
        file.dolby_vision_profile === null ? file.video_range : 'dolby vision'
      ) ?? undefined,
    audioCodec: file.audio_codec?.toUpperCase(),
    audioChannels: audio?.channels ?? undefined,
    audioAtmos: audio?.atmos,
    editionTitle: file.edition ?? undefined,
    container: file.container?.toLowerCase(),
    bitrate: file.bitrate === null ? undefined : Math.round(file.bitrate / 1000),
    fileSize: file.file_size ?? undefined,
    partCount: file.part_count ?? 1,
    filePath: file.file_path,
  };
}

/** The quality columns an item rolls up from its files */
function fileRollup(files: TofaMediaFile[]): Partial<MediaLibraryItem> {
  const versions = files.map(fileVersion);
  const best = pickBestVersion(versions);
  return {
    videoResolution: best?.videoResolution,
    videoCodec: best?.videoCodec,
    videoDynamicRange: best?.videoDynamicRange,
    audioCodec: best?.audioCodec,
    audioChannels: best?.audioChannels,
    fileSize: sumVersionSizes(versions),
    container: best?.container,
    versions,
    versionsFingerprint: computeVersionsFingerprint(versions),
    filePath: best?.filePath,
  };
}

/** Season and episode posters live in tofa's image cache, which the image proxy reads with the key */
function cachedImagePath(path: string): string {
  return `/cache/${path}`;
}

/**
 * A discovery poster counts as a path in tofa's own image cache (a title in its library) or a
 * URL on tofa's cloud asset host (a title not in it); anything else is refused, TMDB's included
 */
export function parseDiscoveryPoster(detail: TofaDiscoveryDetail): string | null {
  const url = detail.poster_url;
  if (!url) return null;
  if (/^images\/[a-z]+\/[^/?#]+$/.test(url)) return cachedImagePath(url);
  return isTofaCloudUrl(url) ? url : null;
}

/**
 * A movie, or a show without its seasons and episodes, which getLibraryLeaves lists. tofa has
 * no music, and an item of its other kind is a lone video, as Plex stores one.
 */
export function parseTofaLibraryItem(detail: TofaMediaDetail): MediaLibraryItem {
  const tvdbId = detail.provider_ids.find((id) => id.provider === 'tvdb')?.provider_id;
  const item: MediaLibraryItem = {
    ratingKey: detail.id,
    title: detail.title,
    mediaType: 'movie',
    year: yearOf(detail.release_date) ?? undefined,
    addedAt: addedDate(detail.files, fileReleaseDates(detail), detail.added_at),
    imdbId: detail.imdb_id ?? undefined,
    tmdbId: detail.tmdb_id ?? undefined,
    tvdbId: tvdbId ? Number(tvdbId) : undefined,
    genres: detail.genres.length > 0 ? detail.genres : undefined,
    thumbPath: tofaPosterPath(detail.id),
  };
  switch (detail.media_type) {
    case 'tv':
      return { ...item, mediaType: 'show' };
    default:
      return { ...item, ...fileRollup(detail.files) };
  }
}

/**
 * The seasons and episodes of a show that have a file. An episode was added when its first
 * file was; it shows its show's poster, as every server's does.
 */
export function parseTofaShowChildren(show: TofaMediaDetail): {
  seasons: MediaLibraryItem[];
  episodes: MediaLibraryItem[];
} {
  const filesByEpisode = Map.groupBy(
    show.files.filter((file) => file.episode_id !== null),
    (file) => file.episode_id
  );
  const releasedOf = fileReleaseDates(show);
  const seasons: MediaLibraryItem[] = [];
  const episodes: MediaLibraryItem[] = [];
  for (const season of show.seasons ?? []) {
    const seasonTitle = season.title ?? `Season ${season.season_number}`;
    let firstAdded: Date | null = null;
    for (const episode of season.episodes ?? []) {
      const files = filesByEpisode.get(episode.id);
      if (!files) continue;
      const addedAt = addedDate(files, releasedOf);
      if (!firstAdded || addedAt < firstAdded) firstAdded = addedAt;
      episodes.push({
        ratingKey: episode.id,
        title: episode.title ?? '',
        mediaType: 'episode',
        year: yearOf(episode.air_date) ?? undefined,
        addedAt,
        tmdbId: episode.tmdb_episode_id ?? undefined,
        grandparentTitle: show.title,
        grandparentRatingKey: show.id,
        parentTitle: seasonTitle,
        parentRatingKey: season.id,
        parentIndex: season.season_number,
        itemIndex: episode.episode_number ?? undefined,
        ...fileRollup(files),
      });
    }
    if (firstAdded) {
      seasons.push({
        ratingKey: season.id,
        title: seasonTitle,
        mediaType: 'season',
        year: yearOf(season.air_date) ?? undefined,
        addedAt: firstAdded,
        parentTitle: show.title,
        parentRatingKey: show.id,
        parentIndex: season.season_number,
        thumbPath: season.poster_path
          ? cachedImagePath(season.poster_path)
          : tofaPosterPath(show.id),
      });
    }
  }
  return { seasons, episodes };
}

export function parseTofaMedia(detail: TofaMediaDetail): TofaMedia {
  const episodes = new Map(
    (detail.seasons ?? []).flatMap((season) =>
      (season.episodes ?? []).map((episode) => [
        episode.id,
        {
          id: episode.id,
          seasonNumber: season.season_number,
          episodeNumber: episode.episode_number,
          title: episode.title,
        },
      ])
    )
  );
  const episodesByFile = new Map(
    detail.files.flatMap((file) => {
      const episode = file.episode_id ? episodes.get(file.episode_id) : undefined;
      return episode ? [[file.id, episode]] : [];
    })
  );
  return {
    kind: detail.media_type,
    title: detail.title,
    year: yearOf(detail.release_date),
    episodesByFile,
  };
}

/**
 * The media a session plays. Without its lookup the session keeps the title it carried and
 * no item key, so the key's arrival on a later poll fills the session in rather than reading
 * as a new item.
 */
function describeMedia(
  row: TofaPlaybackSession,
  media: TofaMedia | undefined
): Pick<MediaSession, 'mediaId' | 'media' | 'episode'> {
  const durationMs = row.duration_ms ?? 0;
  const unresolved = {
    mediaId: '',
    media: { title: row.media_title ?? '', type: 'unknown' as const, durationMs },
  };
  if (!media || !row.media_id) return unresolved;
  const thumbPath = tofaPosterPath(row.media_id);
  const year = media.year ?? undefined;
  switch (media.kind) {
    case 'movie':
      return {
        mediaId: row.media_id,
        media: { title: media.title, type: 'movie', durationMs, year, thumbPath },
      };
    case 'tv': {
      const episode = media.episodesByFile.get(row.media_file_id);
      if (!episode) return unresolved;
      return {
        mediaId: episode.id,
        media: { title: episode.title ?? row.media_title ?? '', type: 'episode', durationMs, year },
        episode: {
          showTitle: media.title,
          showId: row.media_id,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          showThumbPath: thumbPath,
        },
      };
    }
    default:
      return {
        mediaId: row.media_id,
        media: { title: media.title, type: 'unknown', durationMs, year, thumbPath },
      };
  }
}

function channelOf(viewer: TofaLiveViewer): NonNullable<MediaSession['live']> {
  return {
    channelTitle: viewer.channel_name,
    channelIdentifier: viewer.channel_number.display,
    channelThumb: viewer.logo_image_url ?? undefined,
  };
}

/**
 * A play of a live channel, keyed by the channel so it never counts as a play of the item on
 * air. tofa never advances a channel play's position, so the session has no position or length
 * and its time watched is the time it was on the list. A channel built from a library plays the
 * library's files, so an episode on air still names its show.
 */
function describeChannel(
  row: TofaPlaybackSession,
  channelId: string,
  viewer: TofaLiveViewer | undefined,
  media: TofaMedia | undefined
): Pick<MediaSession, 'mediaId' | 'media' | 'episode' | 'live'> {
  const thumbPath = row.media_id ? tofaPosterPath(row.media_id) : undefined;
  const episode = media?.kind === 'tv' ? media.episodesByFile.get(row.media_file_id) : undefined;
  return {
    mediaId: channelId,
    media: {
      title: episode?.title ?? viewer?.programme_title ?? row.media_title ?? '',
      type: 'live',
      durationMs: 0,
      year: media?.year ?? undefined,
      thumbPath,
    },
    episode: episode && {
      showTitle: media?.title ?? '',
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      showThumbPath: thumbPath,
    },
    live: viewer && channelOf(viewer),
  };
}

function subtitleOf(subtitle: NonNullable<TofaPlaybackSession['selected_subtitle']>): SubtitleInfo {
  return {
    codec: subtitle.codec.toUpperCase(),
    language: subtitle.language ?? undefined,
    forced: subtitle.forced || undefined,
    decision: subtitle.burned_in ? 'burn' : undefined,
  };
}

/**
 * What a row plays. A row now-playing does not list may be a channel play, keyed by its channel,
 * so it is described as an unknown item is, with no item key, and also with no length; the
 * poller keeps a tracked play as it is until a later read describes it.
 */
function describePlay(
  row: TofaPlaybackSession,
  nowPlaying: TofaNowPlayingSession | undefined,
  media: TofaMedia | undefined,
  viewer: TofaLiveViewer | undefined
): Pick<MediaSession, 'mediaId' | 'media' | 'episode' | 'live'> {
  if (!nowPlaying) {
    return { mediaId: '', media: { title: row.media_title ?? '', type: 'unknown', durationMs: 0 } };
  }
  return nowPlaying.live_channel_id
    ? describeChannel(row, nowPlaying.live_channel_id, viewer, media)
    : describeMedia(row, media);
}

/**
 * A row of the session list, with what now-playing adds for the same session, the media it
 * plays, and the live viewer it is when it plays a channel. The list's resolution is the output;
 * the source is source_resolution. A relayed client has no address of its own, so the session
 * carries none.
 */
export function parseTofaSession(
  row: TofaPlaybackSession,
  nowPlaying: TofaNowPlayingSession | undefined,
  media: TofaMedia | undefined,
  viewer?: TofaLiveViewer
): MediaSession {
  const [video, audio] =
    DECISION_MODES[row.decision_mode ?? ''] ?? PLAY_METHODS[row.play_method] ?? [];
  const source = frameSize(row.source_resolution);
  const output = frameSize(row.resolution);
  const relayed = row.connection_mode === 'relay';
  // A channel play's position never advances, and a row now-playing does not list may be one
  const playsFile = nowPlaying !== undefined && !nowPlaying.live_channel_id;
  // Players that do not measure their playback still send zero counts
  const health = nowPlaying?.playback_health ? nowPlaying : undefined;

  return {
    sessionKey: row.session_id,
    serverVersionKey: row.media_file_id,
    user: {
      id: row.user_id,
      username: row.username ?? '',
      profileName: row.profile_name ?? undefined,
    },
    ...describePlay(row, nowPlaying, media, viewer),
    playback: {
      state: row.is_paused ? 'paused' : 'playing',
      ...(playsFile
        ? {
            positionMs: row.position_ms,
            progressPercent: calculateProgress(row.position_ms, row.duration_ms ?? 0),
          }
        : { positionMs: 0, progressPercent: 0 }),
    },
    player: {
      name: row.device_name ?? row.client_name ?? '',
      deviceId: row.device_id ?? '',
      product: row.client_name ?? undefined,
      device: row.device_model ?? undefined,
      platform: row.platform ?? undefined,
    },
    network: relayed
      ? { ipAddress: '', isLocal: false, relayed }
      : { ipAddress: row.client_ip ?? '', isLocal: row.connection_mode === 'lan' },
    quality: {
      bitrate: row.source_bitrate_kbps ?? row.observed_bitrate_kbps ?? 0,
      ...normalizeStreamDecisions(video, audio),
      subtitleInfo: row.selected_subtitle ? subtitleOf(row.selected_subtitle) : undefined,
      videoWidth: source.width,
      videoHeight: source.height,
      sourceVideoCodec: sanitizeCodec(row.video_codec) ?? undefined,
      sourceAudioCodec: sanitizeCodec(row.audio_codec) ?? undefined,
      sourceVideoDetails: { dynamicRange: row.source_hdr ?? 'SDR' },
      streamVideoCodec: sanitizeCodec(row.output_video_codec) ?? undefined,
      streamAudioCodec: sanitizeCodec(row.output_audio_codec) ?? undefined,
      streamVideoDetails: { width: output.width, height: output.height },
      transcodeInfo: {
        hwEncoding: row.video_encode?.hardware
          ? (row.video_encode.backend ?? undefined)
          : undefined,
        speed: row.transcode_speed ?? undefined,
        reasons: row.transcode_reason_codes,
        rebufferCount: health?.rebuffer_count,
        rebufferDurationMs: health?.rebuffer_duration_ms ?? undefined,
        droppedFrames: health?.dropped_frames ?? undefined,
      },
    },
  };
}

/**
 * Prefixes the session key of a live viewer listed under now-playing live_sessions with no
 * playback session. tofa stops only playback sessions, so Tracearr cannot stop it.
 */
export const LIVE_VIEWER_PREFIX = 'viewer:';

/** A viewer of a live channel that has no row on the session list */
export function parseTofaLiveSession(live: TofaLiveNowPlayingSession): MediaSession {
  const { viewer, sent } = live;
  return {
    sessionKey: `${LIVE_VIEWER_PREFIX}${viewer.viewer_id}`,
    mediaId: viewer.channel_id,
    user: {
      id: viewer.user_id,
      username: viewer.user_name ?? '',
      profileName: viewer.profile_name ?? undefined,
    },
    media: {
      title: viewer.programme_title ?? viewer.channel_name,
      type: 'live',
      durationMs: 0,
      thumbPath: viewer.logo_image_url ?? undefined,
    },
    live: channelOf(viewer),
    playback: { state: 'playing', positionMs: 0, progressPercent: 0 },
    player: {
      name: viewer.device_name ?? viewer.client_name ?? '',
      deviceId: viewer.viewer_id,
      product: viewer.client_name ?? undefined,
      device: viewer.device_model ?? undefined,
      platform: live.platform ?? undefined,
    },
    network: { ipAddress: '', isLocal: false },
    quality: {
      bitrate: sent?.bitrate_kbps ?? live.source?.bitrate_kbps ?? 0,
      ...normalizeStreamDecisions(
        sent && (sent.video_copied ? 'copy' : 'transcode'),
        sent && (sent.audio_converted ? 'transcode' : 'copy')
      ),
      streamVideoCodec: sanitizeCodec(sent?.video_codec) ?? undefined,
      streamAudioCodec: sanitizeCodec(sent?.audio_codec) ?? undefined,
      streamVideoDetails: { width: sent?.width ?? undefined, height: sent?.height ?? undefined },
      transcodeInfo: { reasons: live.transcode_reason_codes },
    },
  };
}

/** Socket frames that change a session; null for anything else */
export function parseTofaStreamEvent(frame: TofaSocketFrame): TofaStreamEvent | null {
  switch (frame.type) {
    case 'StreamStarted':
    case 'StreamUpdated':
    case 'StreamProgress':
      return { kind: 'changed', sessionId: frame.session_id };
    case 'StreamStopped':
      return {
        kind: 'stopped',
        sessionId: frame.session_id,
        positionMs: frame.position_ms ?? null,
        stoppedByAdmin: frame.reason === 'admin_stopped',
      };
    case 'EventsMissed':
      return { kind: 'missed' };
    default:
      return null;
  }
}

/** Socket frames that say a library's content changed, which the next sync reads */
export function isLibraryChange(frame: TofaSocketFrame): boolean {
  switch (frame.type) {
    case 'MediaAdded':
    case 'MediaUpdated':
    case 'MediaDeleted':
    case 'ScanCompleted':
      return true;
    default:
      return false;
  }
}

/** Socket frames that say a request was made, changed or removed, which the next request sync reads */
export function isRequestChange(frame: TofaSocketFrame): boolean {
  switch (frame.type) {
    case 'RequestCreated':
    case 'RequestUpdated':
    case 'RequestDeleted':
      return true;
    default:
      return false;
  }
}

/**
 * Host load over the last windowSeconds of tofa's samples. The server's share of CPU counts its
 * transcodes and preview work with it.
 */
export function parseTofaMetrics(
  metrics: TofaMetrics,
  windowSeconds: number
): ServerResourceDataPoint[] {
  const newest = Math.max(0, ...metrics.history.map((sample) => sample.t));
  return metrics.history
    .filter((sample) => sample.t >= newest - windowSeconds * 1000)
    .map((sample) => ({
      at: Math.floor(sample.t / 1000),
      timespan: metrics.cadence_secs,
      hostCpuUtilization: sample.cpu_total,
      processCpuUtilization:
        sample.cpu_tofa +
        sample.cpu_transcode +
        (sample.cpu_quickview ?? 0) +
        (sample.cpu_fillview ?? 0),
      hostMemoryUtilization: (sample.mem_used / sample.mem_total) * 100,
      processMemoryUtilization: (sample.mem_tofa / sample.mem_total) * 100,
    }));
}

/**
 * A download's file, and what left the server: the file itself, or the quality it was converted
 * to, whose size tofa only estimates. tofa reports no address for a download.
 */
export function parseTofaDownloadSource(
  request: DownloadSourceRequest,
  download: TofaDownload | undefined,
  file: TofaMediaFile | undefined
): DownloadSourceDescription {
  const version = file && fileVersion(file);
  const option = file?.download_options?.find((o) => o.tag === download?.quality_key);
  const delivered =
    version && option?.is_original
      ? {
          bytes: version.fileSize ?? null,
          videoCodec: version.videoCodec ?? null,
          audioCodec: version.audioCodec ?? null,
          container: version.container ?? null,
          bitrateKbps: version.bitrate ?? null,
          resolution: null,
        }
      : option && {
          bytes: option.size_is_estimate ? null : option.size_bytes,
          videoCodec: null,
          audioCodec: null,
          container: null,
          bitrateKbps: option.bitrate_kbps,
          resolution: null,
        };
  return {
    version: version
      ? {
          key: version.serverVersionKey,
          size: version.fileSize ?? null,
          container: version.container ?? null,
          videoResolution: version.videoResolution ?? null,
          videoCodec: version.videoCodec ?? null,
          videoDynamicRange: version.videoDynamicRange ?? null,
        }
      : null,
    delivered: delivered ?? null,
    device: {
      deviceId: request.deviceId,
      playerName: download?.device_name ?? request.device,
      product: request.app,
      platform: null,
    },
    ipAddress: null,
  };
}
