export interface HistoryRow {
  id: string;
  started_at: Date;
  stopped_at: Date | null;
  duration_ms: string | null;
  paused_duration_ms: string | null;
  progress_ms: number | null;
  total_duration_ms: number | null;
  segment_count: string;
  segments?:
    | {
        started_at: string;
        stopped_at: string | null;
        duration_ms: string | null;
        paused_duration_ms: string | null;
      }[]
    | null;
  watched: boolean;
  state: string;
  server_id: string;
  server_name: string;
  server_type: string;
  server_user_id: string;
  username: string;
  user_thumb: string | null;
  identity_name: string | null;
  session_key: string;
  media_type: string;
  media_title: string;
  grandparent_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  year: number | null;
  artist_name: string | null;
  album_name: string | null;
  thumb_path: string | null;
  media_id: string | null;
  show_media_id: string | null;
  reference_id: string | null;
  ip_address: string | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_country: string | null;
  geo_continent: string | null;
  geo_postal: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
  geo_asn_number: number | null;
  geo_asn_organization: string | null;
  is_local: boolean;
  player_name: string | null;
  device_id: string | null;
  product: string | null;
  device: string | null;
  platform: string | null;
  quality: string | null;
  is_transcode: boolean | null;
  video_decision: string | null;
  audio_decision: string | null;
  bitrate: number | null;
  source_video_codec: string | null;
  source_audio_codec: string | null;
  source_audio_channels: number | null;
  source_video_width: number | null;
  source_video_height: number | null;
  source_video_details: Record<string, unknown> | null;
  source_audio_details: Record<string, unknown> | null;
  stream_video_codec: string | null;
  stream_audio_codec: string | null;
  stream_video_details: Record<string, unknown> | null;
  stream_audio_details: Record<string, unknown> | null;
  transcode_info: Record<string, unknown> | null;
  subtitle_info: Record<string, unknown> | null;
  sort_key?: string | number | null;
  page_candidate_count?: number;
}

export function mapHistoryRow(row: HistoryRow) {
  return {
    id: row.id,
    serverId: row.server_id,
    serverUserId: row.server_user_id,
    user: {
      id: row.server_user_id,
      username: row.username,
      thumbUrl: row.user_thumb,
      identityName: row.identity_name,
    },
    server: {
      id: row.server_id,
      name: row.server_name,
      type: row.server_type as 'plex' | 'jellyfin' | 'emby',
    },
    sessionKey: row.session_key,
    state: row.state,
    mediaType: row.media_type,
    mediaTitle: row.media_title,
    grandparentTitle: row.grandparent_title,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    year: row.year,
    artistName: row.artist_name,
    albumName: row.album_name,
    thumbPath: row.thumb_path,
    mediaId: row.media_id,
    showMediaId: row.show_media_id,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    stoppedAt: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
    durationMs: row.duration_ms ? Number(row.duration_ms) : null,
    pausedDurationMs: row.paused_duration_ms ? Number(row.paused_duration_ms) : null,
    progressMs: row.progress_ms,
    totalDurationMs: row.total_duration_ms,
    referenceId: row.reference_id,
    watched: row.watched,
    segmentCount: Number(row.segment_count),
    segments: row.segments?.map((seg) => ({
      startedAt: new Date(seg.started_at).toISOString(),
      stoppedAt: seg.stopped_at ? new Date(seg.stopped_at).toISOString() : null,
      durationMs: seg.duration_ms != null ? Number(seg.duration_ms) : null,
      pausedDurationMs: seg.paused_duration_ms != null ? Number(seg.paused_duration_ms) : 0,
    })),
    ipAddress: row.ip_address,
    geoCity: row.geo_city,
    geoRegion: row.geo_region,
    geoCountry: row.geo_country,
    geoContinent: row.geo_continent,
    geoPostal: row.geo_postal,
    geoLat: row.geo_lat,
    geoLon: row.geo_lon,
    geoAsnNumber: row.geo_asn_number,
    geoAsnOrganization: row.geo_asn_organization,
    isLocal: row.is_local === true,
    playerName: row.player_name,
    deviceId: row.device_id,
    product: row.product,
    device: row.device,
    platform: row.platform,
    quality: row.quality,
    isTranscode: row.is_transcode,
    videoDecision: row.video_decision,
    audioDecision: row.audio_decision,
    bitrate: row.bitrate,
    // Stream detail fields
    sourceVideoCodec: row.source_video_codec,
    sourceAudioCodec: row.source_audio_codec,
    sourceAudioChannels: row.source_audio_channels,
    sourceVideoWidth: row.source_video_width,
    sourceVideoHeight: row.source_video_height,
    sourceVideoDetails: row.source_video_details,
    sourceAudioDetails: row.source_audio_details,
    streamVideoCodec: row.stream_video_codec,
    streamAudioCodec: row.stream_audio_codec,
    streamVideoDetails: row.stream_video_details,
    streamAudioDetails: row.stream_audio_details,
    transcodeInfo: row.transcode_info,
    subtitleInfo: row.subtitle_info,
  };
}
