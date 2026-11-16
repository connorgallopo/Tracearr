/**
 * tofa API response shapes, limited to the fields Tracearr reads. Field names and
 * nullability follow the server's own OpenAPI spec (0.13.2, API 164).
 */

export interface TofaSystemInfo {
  version: string;
  server_id?: string | null;
  watched_rule?: { percent: number } | null;
  /** Whether the owner turned requests on; absent on servers without requests */
  requests_available?: boolean;
}

export interface TofaApiKey {
  key_prefix: string;
  revoked_at: string | null;
  /** Absent on servers older than API key scopes, whose keys are all full admin */
  read_only?: boolean;
  can_stop_streams?: boolean;
}

export interface TofaUser {
  id: string;
  username: string;
  email?: string | null;
  is_admin?: boolean | null;
  disabled: boolean;
}

export interface TofaCloudUser {
  local_user_id: string;
  /** The tofa cloud account, the sub of its cloud token */
  cloud_identity_id: string | null;
  revoked_at: string | null;
  library_ids: string[];
  unrestricted_libraries: boolean;
}

/** One entry of /import/accounts/all: an account on another server a tofa user imports from */
export interface TofaAccountLink {
  user_id: string;
  /** plex, jellyfin or emby */
  provider: string;
  /** The account's id on that server; a Plex account by its local id or its plex.tv id */
  external_user_id?: string | null;
  /** That server's own identifier */
  external_server_id?: string | null;
}

export interface TofaLibrary {
  id: string;
  name: string;
  /** movie, tv or other */
  media_type: string;
}

export interface TofaUpdateStatus {
  state: string;
  /** The release the server's update check found */
  version?: string | null;
}

export interface TofaKeyScopes {
  readOnly: boolean;
  canStopStreams: boolean;
}

/** One row of /system/playback/sessions */
export interface TofaPlaybackSession {
  session_id: string;
  user_id: string;
  username?: string | null;
  profile_name?: string | null;
  media_id?: string | null;
  media_file_id: string;
  media_title?: string | null;
  position_ms: number;
  duration_ms?: number | null;
  is_paused: boolean;
  created_at: string;
  /** DirectPlay, DirectStream or Transcode */
  play_method: string;
  /** DirectFile, HlsRemux, HlsCopyVideoTranscodeAudio or HlsFullTranscode */
  decision_mode?: string | null;
  transcode_reason_codes: string[];
  client_name?: string | null;
  device_model?: string | null;
  device_name?: string | null;
  device_id?: string | null;
  client_ip?: string | null;
  /** The subtitle track the player shows; null when it shows none or does not say */
  selected_subtitle?: {
    codec: string;
    language: string | null;
    forced: boolean;
    burned_in: boolean;
  } | null;
  /** lan, wan or relay, set by the server */
  connection_mode?: string | null;
  platform?: string | null;
  video_codec?: string | null;
  output_video_codec?: string | null;
  audio_codec?: string | null;
  output_audio_codec?: string | null;
  /** The output: WIDTHxHEIGHT, or a height label such as 1080p */
  resolution?: string | null;
  source_resolution?: string | null;
  source_hdr?: string | null;
  source_bitrate_kbps?: number | null;
  observed_bitrate_kbps?: number | null;
  transcode_speed?: number | null;
  video_encode?: { hardware: boolean; backend: string | null } | null;
}

/** The fields /system/activity/now-playing adds to a playback session */
export interface TofaNowPlayingSession {
  session_id: string;
  live_channel_id?: string | null;
  rebuffer_count: number;
  rebuffer_duration_ms?: number | null;
  dropped_frames?: number | null;
  /** Filled only by players that measure their playback; null for the others */
  playback_health?: { player: string } | null;
}

/** A viewer of a live channel, as /live/admin/now and now-playing live_sessions list it */
export interface TofaLiveViewer {
  viewer_id: string;
  channel_id: string;
  channel_name: string;
  channel_number: { display: string };
  logo_image_url: string | null;
  programme_title: string | null;
  user_id: string;
  user_name: string | null;
  profile_name: string | null;
  device_name: string | null;
  client_name: string | null;
  device_model: string | null;
}

/** One entry of now-playing live_sessions: a viewer watching a live channel */
export interface TofaLiveNowPlayingSession {
  session_id: string;
  viewer: TofaLiveViewer;
  platform: string | null;
  source: { bitrate_kbps: number | null } | null;
  sent: {
    video_copied: boolean;
    video_codec: string | null;
    audio_codec: string | null;
    audio_converted: boolean;
    width: number | null;
    height: number | null;
    bitrate_kbps: number | null;
  } | null;
  transcode_reason_codes: string[];
}

export interface TofaNowPlaying {
  sessions: TofaNowPlayingSession[];
  live_sessions?: TofaLiveNowPlayingSession[];
}

export interface TofaLiveAdminNow {
  sessions: TofaLiveViewer[];
}

export interface TofaMediaFile {
  id: string;
  episode_id: string | null;
  available: boolean;
  file_path: string;
  file_size: number | null;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  /** WIDTHxHEIGHT */
  resolution: string | null;
  /** Bits per second */
  bitrate: number | null;
  /** SDR, HDR10, HDR10+ or HLG; a Dolby Vision file names its fallback layer here */
  video_range: string | null;
  dolby_vision_profile: number | null;
  edition?: string | null;
  part_count: number | null;
  /** When the file changed on disk, which tofa takes as the date the item was added */
  file_modified_at: string | null;
  /** When tofa first saw the file */
  created_at: string;
  audio_tracks: { channels: number | null; atmos?: boolean }[];
  /** The qualities a client can download; the original is the file itself */
  download_options?:
    | {
        tag: string;
        is_original: boolean;
        bitrate_kbps: number;
        size_bytes: number | null;
        size_is_estimate: boolean;
      }[]
    | null;
}

export interface TofaEpisode {
  id: string;
  episode_number: number | null;
  title: string | null;
  air_date?: string | null;
  tmdb_episode_id?: number | null;
}

export interface TofaSeason {
  id: string;
  season_number: number;
  title?: string | null;
  poster_path?: string | null;
  air_date?: string | null;
  episodes?: TofaEpisode[] | null;
}

/** /media/{id} and /media/batch: a movie, or a show with its seasons and every file */
export interface TofaMediaDetail {
  id: string;
  library_id: string;
  /** movie, tv or other */
  media_type: string;
  title: string;
  release_date?: string | null;
  added_at?: string | null;
  imdb_id?: string | null;
  tmdb_id?: number | null;
  provider_ids: { provider: string; provider_id: string }[];
  genres: string[];
  files: TofaMediaFile[];
  seasons?: TofaSeason[] | null;
}

/** A page of /media, the library listing; only the ids are read, details come from /media/batch */
export interface TofaMediaPage {
  items: { id: string }[];
  total: number;
}

/** A page of /media/files: every file of a library, in file id order */
export interface TofaLibraryFiles {
  items: {
    media_file_id: string;
    media_id: string;
    episode_id?: string | null;
    season_number?: number | null;
    episode_number?: number | null;
    available: boolean;
  }[];
  next_after?: string | null;
}

/** /media/changes: every library change after a revision, while tofa still holds them */
export interface TofaMediaChanges {
  changes: {
    revision: number;
    media_id: string;
    library_id?: string | null;
    change_kind: 'upsert' | 'delete';
  }[];
  latest_revision: number;
  requires_full_sync: boolean;
}

/** What a session needs from its media: its kind, and for a show the episode each file holds */
export interface TofaMedia {
  /** movie, tv or other */
  kind: string;
  title: string;
  year: number | null;
  episodesByFile: Map<string, TofaEpisodeRef>;
}

export interface TofaEpisodeRef {
  id: string;
  seasonNumber: number;
  episodeNumber: number | null;
  title: string | null;
}

/** One finished play in /system/watch-history */
export interface TofaWatchHistoryRow {
  id: string;
  /** The playback session the play was, as the session list and socket named it */
  session_id?: string | null;
  user_id: string;
  username: string;
  /** The profile that played */
  profile_id?: string | null;
  profile_name?: string | null;
  media_id?: string | null;
  episode_id?: string | null;
  /** movie, tv or other */
  media_type?: string | null;
  title: string;
  season_number?: number | null;
  episode_number?: number | null;
  episode_title?: string | null;
  /** DirectPlay, DirectStream or Transcode */
  play_method: string;
  client_name?: string | null;
  platform?: string | null;
  device_model?: string | null;
  device_name?: string | null;
  device_id?: string | null;
  client_ip?: string | null;
  /** The media's runtime */
  duration_ms?: number | null;
  position_ms: number;
  started_at: string;
  ended_at?: string | null;
}

/** A profile of a user's account, from /profiles and /users/{id}/profiles */
export interface TofaProfile {
  id: string;
  user_id: string;
  name: string;
  is_primary?: boolean;
  /** `preset:<id>` for one of the server's bundled avatars */
  avatar_ref?: string | null;
  /** The uploaded photo, a full URL on tofa's side; null until the person uploads one */
  avatar_image_url?: string | null;
}

export interface TofaWatchHistory {
  items: TofaWatchHistoryRow[];
  has_more: boolean;
}

/** One offline download in /system/downloads */
export interface TofaDownload {
  id: string;
  created_at: string;
  user_id: string;
  device_id: string;
  device_name: string | null;
  media_id: string;
  media_file_id: string;
  /** movie, tv or other */
  media_type: string | null;
  title: string;
  episode_title: string | null;
  /** original, or the tag of the download option it was converted to */
  quality_key: string;
}

export interface TofaDownloads {
  items: TofaDownload[];
  has_more: boolean;
}

/**
 * /discovery/detail/{media_type}/{tmdb_id}. The spec lists no poster field on it; tofa 0.13.3
 * sends poster_url, a path in its image cache for a title in the library and a cloud asset URL
 * otherwise.
 */
export interface TofaDiscoveryDetail {
  poster_url?: string | null;
}

/** One request in /requests; a TV request's seasons each carry their own status */
export interface TofaRequest {
  id: string;
  tmdb_id: number;
  tvdb_id?: number | null;
  /** movie, tv or other */
  media_type: string;
  title: string;
  /** The tofa user the request is for, also when someone else filed it; the id sessions and /users carry */
  requested_by: string;
  requested_by_name?: string | null;
  /** pending_approval, requested, downloading, available, denied, failed or retrying */
  status: string;
  is4k: boolean;
  created_at: string;
  updated_at: string;
  resolved_at?: string | null;
  seasons: { season_number: number; status: string }[];
}

/** One sample of /system/metrics history; CPU in percent of the host */
export interface TofaMetricSample {
  /** Unix milliseconds */
  t: number;
  cpu_total: number;
  cpu_tofa: number;
  cpu_transcode: number;
  cpu_quickview?: number | null;
  cpu_fillview?: number | null;
  mem_total: number;
  mem_used: number;
  mem_tofa: number;
}

/** /system/metrics: the host's last few minutes, sampled every cadence_secs */
export interface TofaMetrics {
  cadence_secs: number;
  history: TofaMetricSample[];
}

/** The socket frames Tracearr reads. Any other type, most of them AppLog, is dropped. */
export type TofaSocketFrame =
  | { type: 'auth_ok' }
  | { type?: undefined; error: string }
  | { type: 'StreamStarted' | 'StreamUpdated' | 'StreamProgress'; session_id: string }
  | {
      type: 'StreamStopped';
      session_id: string;
      position_ms?: number | null;
      /** null for a viewer's own stop; admin_stopped when an admin or Tracearr stopped it */
      reason?: string | null;
    }
  | { type: 'EventsMissed'; missed: number }
  | { type: 'MediaAdded' | 'MediaUpdated' | 'MediaDeleted'; media_id: string }
  | { type: 'ScanCompleted'; library_id: string }
  | { type: 'RequestCreated' | 'RequestUpdated' | 'RequestDeleted'; request_id: string };

export type TofaStreamEvent =
  | { kind: 'changed'; sessionId: string }
  | { kind: 'stopped'; sessionId: string; positionMs: number | null; stoppedByAdmin: boolean }
  | { kind: 'missed' };
