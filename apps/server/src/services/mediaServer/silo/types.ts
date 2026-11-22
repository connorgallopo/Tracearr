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
