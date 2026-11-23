/**
 * Silo API response shapes, as its /api/v2 OpenAPI names them. Only the fields Tracearr reads
 * are declared.
 */

export interface SiloSystemInfo {
  server_version: string;
  api_major: number;
  contract_digest: string;
}

export interface SiloServerIdentity {
  server_id: string;
}

export interface SiloPage<T> {
  items: T[];
  page?: { has_more: boolean; next_cursor?: string };
}

export interface SiloUser {
  id: string;
  username: string;
  email: string;
  role: string;
  enabled: boolean;
  effective_policy: {
    /** null: every library */
    library_ids: string[] | null;
  };
  last_active_at: string | null;
}

export interface SiloProfile {
  id: string;
  name: string;
  is_primary: boolean;
  is_child: boolean;
}

/** An entry of GET /profiles, the signed-in account's own profiles */
export interface SiloOwnProfile {
  id: string;
  is_primary: boolean;
  has_pin: boolean;
}

export interface SiloDevice {
  device_id: string;
  device_name: string;
}

export interface SiloLibrary {
  id: string;
  name: string;
  type: string;
}

export interface SiloSubtitle {
  codec: string | null;
  language: string | null;
  forced: boolean;
  delivery: string;
}

export interface SiloSession {
  session_id: string;
  started_at: string;
  user_id: string;
  username: string;
  profile_id: string;
  profile_name?: string;
  media_file_id: string;
  media_item_id?: string;
  media_title: string;
  media_type: string;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
  poster_url?: string;
  /** seconds */
  file_duration: number | null;
  position_seconds: number;
  is_paused: boolean;
  client_ip?: string;
  stream_location: string;
  client_name?: string;
  device_id?: string;
  device_platform?: string;
  stream_bitrate_kbps: number | null;
  source_bitrate_kbps: number | null;
  target_bitrate_kbps: number | null;
  video_decision?: string;
  audio_decision?: string;
  source_container?: string;
  source_video_codec?: string;
  source_video_height?: number;
  source_audio_codec?: string;
  source_audio_channels: number | null;
  source_audio_language?: string;
  source_audio_layout?: string;
  target_video_codec?: string;
  target_audio_codec?: string;
  target_audio_channels?: number;
  transcode_hw_accel?: string;
  output_container?: string;
  adaptation_reasons?: string[];
  subtitle: SiloSubtitle | null;
}

export interface SiloCatalogVersion {
  file_id: string;
  library_id: string;
  resolution?: string;
  codec_video?: string;
  dynamic_range?: string;
  codec_audio?: string;
  audio_channels?: number;
  atmos: boolean;
  edition?: string;
  container?: string;
  bitrate_kbps?: number;
  file_size: number;
}

export interface SiloCatalogItem {
  content_id: string;
  type: string;
  title: string;
  year?: number;
  imdb_id?: string;
  /** Silo sends the numeric provider ids as strings */
  tmdb_id?: string;
  tvdb_id?: string;
  genres?: string[];
  library_ids: string[];
  added_at: string;
  versions: SiloCatalogVersion[];
  poster_url?: string;
  series_id?: string;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
}

export interface SiloSocketTicket {
  ticket: string;
  expires_in: number;
  max_connection_seconds: number;
  protocol: string;
}

/** A frame on the events socket */
export interface SiloSocketFrame {
  type?: string;
  channel?: string;
  event?: string;
  channels?: string[];
  data?: unknown;
  /** On an error frame */
  code?: string;
  message?: string;
}

/** The data of a catalog.item.changed (change) or catalog.library.changed (reason) event */
export interface SiloCatalogChange {
  library_id?: string;
  content_id?: string;
  change?: string;
  reason?: string;
}

/** The data of a session.stopped event */
export interface SiloSessionStopped {
  session_id: string;
  end_reason: string | null;
  history?: { end_position_seconds: number } | null;
}

/** One finished play in /admin/playback-history: one row per playback session, keyed by its id */
export interface SiloHistoryRow {
  session_id: string;
  user_id: string;
  /** Empty once the account is gone */
  username: string;
  profile_id: string;
  /** The profile id itself when Silo recorded no name */
  profile_name: string;
  /** The episode's content id for an episode, else the item's; empty when the play was not attributed */
  media_item_id: string;
  media_file_id: string;
  media_title: string;
  /** episode, else the catalog item's type; empty once the item left the catalog */
  media_type: string;
  started_at: string;
  ended_at: string;
  /** Where the play ended, not how long it was watched */
  end_position_seconds: number;
  duration_seconds: number | null;
  /** Measured watch time; null when Silo did not measure the play */
  played_seconds: number | null;
  paused_seconds: number | null;
  series_title: string;
  season_number: number | null;
  episode_number: number | null;
  client_ip: string | null;
  device_id: string | null;
  device_platform: string | null;
  client_name: string | null;
  video_decision: string | null;
  audio_decision: string | null;
}

export interface SiloDownloadEntry {
  id: string;
  user_id: string;
  profile_id: string;
  device_id: string;
  device_name: string;
  content_id: string;
  episode_id?: string;
  title: string;
  episode: { season_number: number; episode_number: number; title: string } | null;
  file_size: number;
  target_bitrate_kbps: number;
  delivery_format: string;
  created_at: string;
  created_client_ip: string | null;
  last_client_ip: string | null;
}

export interface SiloSystemResources {
  available: boolean;
  stale: boolean;
  sampled_at?: string;
  system?: { cpu_pct: number; cores: number; mem_used_mb: number; mem_total_mb: number };
  attribution?: {
    sample_interval_seconds: number;
    /** available: false when Silo could not take that reading this sample */
    cpu?: { available: boolean };
    memory?: { available: boolean };
    process?: { resident_bytes?: number };
  };
}

export interface SiloDeviceLoginStart {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface SiloTokenPair {
  access_token: string;
  user: { id: string; username: string; email?: string; role: string };
}

export interface SiloDeviceLoginPoll {
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'canceled' | 'expired';
  opened: boolean;
  expires_at?: string;
  poll_after: number;
  /** Only on approved, and only once */
  tokens?: SiloTokenPair;
}

export interface SiloDeviceLoginCapability {
  state: 'available' | 'disabled' | 'not_configured' | 'unsupported';
  session_binding: boolean;
}

export interface SiloAuthProviders {
  password_login: boolean;
}

export interface SiloProfileVerification {
  valid: boolean;
  /** Absent when the PIN did not match */
  profile_token?: string;
}

export interface SiloCreatedKey {
  id: string;
  key: string;
}

export interface SiloRequestSeasonProgress {
  season_number: number;
  episodes_aired: number;
  episodes_available: number;
}

/** A row of /admin/requests */
export interface SiloRequest {
  id: string;
  media_type: string;
  tmdb_id: number;
  tvdb_id?: number;
  imdb_id?: string;
  title: string;
  /** What Silo shows; status stays pending on a cancelled request */
  state: string;
  /** Series: empty means the whole series */
  seasons: number[];
  /** Empty until the series is in the library */
  season_progress: SiloRequestSeasonProgress[];
  /** direct or watchlist, more values may come */
  source: string;
  requested_by_user_id?: string;
  requested_by_profile_id?: string;
  library_content_id?: string;
  poster_url?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface SiloRequestCounts {
  requests_enabled: boolean;
}
