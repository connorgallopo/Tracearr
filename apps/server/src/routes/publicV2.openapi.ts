/**
 * OpenAPI Schema Definitions for Public API v2
 *
 * Uses @asteasolutions/zod-to-openapi to generate OpenAPI 3.0 documentation.
 * v2 keeps its own registry and document generator so its schemas and paths
 * evolve independently of v1.
 */

import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ============================================================================
// Security Scheme
// ============================================================================

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'API key format: trr_pub_<token>. Generate in Settings > General.',
});

// ============================================================================
// Shared error responses
//
// Every v2 path shares the same auth preHandler and the same plugin-level
// rate-limit hook, so 401/403/429 are reachable on all of them alike; spread
// this into each path's responses instead of repeating three lines per path.
// ============================================================================

const AUTH_ERROR_RESPONSES = {
  401: { description: 'Invalid or missing API key' },
  403: { description: 'API key is not associated with an owner account' },
  429: {
    description: "Rate limit exceeded for this key's shared budget across the whole v2 surface",
  },
} as const;

// ============================================================================
// Shared query param schemas
//
// Query strings arrive as strings; runtime validation uses booleanStringSchema
// (accepts a JSON boolean or the string "true"/"false") and z.coerce.date()
// (accepts a date-only string like "2024-01-01" as well as a full ISO datetime).
// These document that actual accepted shape rather than the stricter type a
// plain z.boolean()/z.iso.datetime() would imply.
// ============================================================================

const QueryBoolean = z.union([z.boolean(), z.string()]);
const QueryDate = z.union([z.iso.date(), z.iso.datetime()]);

// ============================================================================
// GET /docs
// ============================================================================

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/docs',
  tags: ['Public API v2'],
  summary: 'OpenAPI specification',
  description: 'Returns the OpenAPI 3.0 specification for the v2 public API.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Specification retrieved',
      content: { 'application/json': { schema: z.object({}).openapi('OpenApiDocument') } },
    },
    ...AUTH_ERROR_RESPONSES,
  },
});

// ============================================================================
// Shared Schemas
// ============================================================================

const PLAY_SEMANTICS =
  'A play is one resume chain: sessions are grouped by COALESCE(reference_id, id), where ' +
  'reference_id IS NULL marks the chain start. Chains where no session reaches 2 minutes are ' +
  'excluded (COALESCE(duration_ms, 0) >= 120000). Rating keys the media server never provided ' +
  'are returned as null.';

const ServerTypeEnum = z.enum(['plex', 'jellyfin', 'emby']);
// Responses can carry 'trailer' (sessions store it); the history filter
// deliberately accepts only the six primary types.
const MediaTypeEnum = z.enum(['movie', 'episode', 'track', 'live', 'photo', 'trailer', 'unknown']);
const MediaTypeFilterEnum = z.enum(['movie', 'episode', 'track', 'live', 'photo', 'unknown']);
const TranscodeDecisionEnum = z.enum(['directplay', 'copy', 'transcode']);

const CursorMeta = z
  .object({
    nextCursor: z
      .string()
      .nullable()
      .openapi({ description: 'Opaque cursor for the next page; null when no further pages' }),
    pageSize: z.number().int().openapi({ example: 25 }),
  })
  .openapi('CursorMeta');

const SourceVideoDetails = z
  .object({
    bitrate: z.number().optional(),
    framerate: z.string().optional().openapi({ example: '23.976' }),
    dynamicRange: z.string().optional().openapi({ example: 'HDR10' }),
    aspectRatio: z.number().optional().openapi({ example: 1.78 }),
    profile: z.string().optional().openapi({ example: 'main 10' }),
    level: z.string().optional().openapi({ example: '5.1' }),
    colorSpace: z.string().optional().openapi({ example: 'bt2020nc' }),
    colorDepth: z.number().optional().openapi({ example: 10 }),
  })
  .nullable()
  .openapi('SourceVideoDetails');

const SourceAudioDetails = z
  .object({
    bitrate: z.number().optional(),
    channelLayout: z.string().optional().openapi({ example: '7.1' }),
    language: z.string().optional().openapi({ example: 'eng' }),
    sampleRate: z.number().optional().openapi({ example: 48000 }),
  })
  .nullable()
  .openapi('SourceAudioDetails');

const StreamVideoDetails = z
  .object({
    bitrate: z.number().optional(),
    width: z.number().optional().openapi({ example: 1920 }),
    height: z.number().optional().openapi({ example: 1080 }),
    framerate: z.string().optional().openapi({ example: '23.976' }),
    dynamicRange: z.string().optional().openapi({ example: 'SDR' }),
  })
  .nullable()
  .openapi('StreamVideoDetails');

const StreamAudioDetails = z
  .object({
    bitrate: z.number().optional(),
    channels: z.number().optional().openapi({ example: 2 }),
    language: z.string().optional().openapi({ example: 'eng' }),
  })
  .nullable()
  .openapi('StreamAudioDetails');

const TranscodeInfo = z
  .object({
    containerDecision: TranscodeDecisionEnum.optional(),
    sourceContainer: z.string().optional().openapi({ example: 'mkv' }),
    streamContainer: z.string().optional().openapi({ example: 'mpegts' }),
    hwRequested: z.boolean().optional(),
    hwDecoding: z.string().optional().openapi({ example: 'videotoolbox' }),
    hwEncoding: z.string().optional().openapi({ example: 'videotoolbox' }),
    speed: z.number().optional().openapi({ description: 'Transcode speed multiplier' }),
    throttled: z.boolean().optional(),
    reasons: z.array(z.string()).optional(),
  })
  .nullable()
  .openapi('TranscodeInfo');

const SubtitleInfo = z
  .object({
    decision: z.string().optional().openapi({ example: 'burn' }),
    codec: z.string().optional().openapi({ example: 'srt' }),
    language: z.string().optional().openapi({ example: 'eng' }),
    forced: z.boolean().optional(),
  })
  .nullable()
  .openapi('SubtitleInfo');

const mediaIdentityFields = {
  media_id: z
    .uuid()
    .nullable()
    .openapi({ description: 'Canonical media id, shared across servers' }),
  show_media_id: z
    .uuid()
    .nullable()
    .openapi({ description: 'Canonical id of the parent show (episodes only)' }),
  imdb_id: z.string().nullable().openapi({ example: 'tt1375666' }),
  tmdb_id: z.number().int().nullable().openapi({ example: 27205 }),
  tvdb_id: z.number().int().nullable(),
  rating_key: z
    .string()
    .nullable()
    .openapi({ description: 'Server-specific media id; null when the server never provided one' }),
  parent_rating_key: z.string().nullable(),
  grandparent_rating_key: z.string().nullable(),
  library_id: z.string().nullable().openapi({
    description: "The server's library identifier when the item is in a synced library",
  }),
  genres: z
    .array(z.string())
    .nullable()
    .openapi({ example: ['Action', 'Sci-Fi'] }),
};

const streamQualityFields = {
  is_transcode: z.boolean(),
  video_decision: TranscodeDecisionEnum.nullable(),
  audio_decision: TranscodeDecisionEnum.nullable(),
  bitrate: z.number().int().nullable().openapi({ description: 'Bitrate in kbps' }),
  source_video_codec: z.string().nullable().openapi({ example: 'hevc' }),
  source_audio_codec: z.string().nullable().openapi({ example: 'truehd' }),
  source_audio_channels: z.number().int().nullable().openapi({ example: 8 }),
  source_video_width: z.number().int().nullable().openapi({ example: 3840 }),
  source_video_height: z.number().int().nullable().openapi({ example: 2160 }),
  source_video_details: SourceVideoDetails,
  source_audio_details: SourceAudioDetails,
  stream_video_codec: z.string().nullable().openapi({ example: 'h264' }),
  stream_audio_codec: z.string().nullable().openapi({ example: 'aac' }),
  stream_video_details: StreamVideoDetails,
  stream_audio_details: StreamAudioDetails,
  transcode_info: TranscodeInfo,
  subtitle_info: SubtitleInfo,
  resolution: z.string().nullable().openapi({ example: '4K' }),
  source_video_codec_display: z.string().nullable().openapi({ example: 'HEVC' }),
  source_audio_codec_display: z.string().nullable().openapi({ example: 'TrueHD' }),
  audio_channels_display: z.string().nullable().openapi({ example: '7.1' }),
  stream_video_codec_display: z.string().nullable().openapi({ example: 'H.264' }),
  stream_audio_codec_display: z.string().nullable().openapi({ example: 'AAC' }),
};

const mediaMetadataFields = {
  media_type: MediaTypeEnum,
  media_title: z.string().openapi({ example: 'Inception' }),
  show_title: z.string().nullable().openapi({ description: 'Show name (episodes only)' }),
  season_number: z.number().int().nullable(),
  episode_number: z.number().int().nullable(),
  year: z.number().int().nullable().openapi({ example: 2010 }),
  artist_name: z.string().nullable().openapi({ description: 'Music tracks only' }),
  album_name: z.string().nullable().openapi({ description: 'Music tracks only' }),
  track_number: z.number().int().nullable(),
  disc_number: z.number().int().nullable(),
  thumb_path: z.string().nullable().openapi({ description: 'Poster path' }),
  poster_url: z.string().nullable().openapi({ description: 'Proxied poster URL' }),
};

const deviceFields = {
  device: z.string().nullable().openapi({ example: 'Apple TV' }),
  player: z.string().nullable().openapi({ example: 'Plex for Apple TV' }),
  product: z.string().nullable().openapi({ example: 'Plex for Apple TV' }),
  platform: z.string().nullable().openapi({ example: 'tvOS' }),
};

// ============================================================================
// GET /history
// ============================================================================

const HistoryQuery = z.object({
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from meta.nextCursor' }),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  user_id: z.uuid().optional().openapi({
    description: 'Filter by Tracearr user id; matches every account linked to that identity',
  }),
  server_id: z.uuid().optional().openapi({ description: 'Filter to specific server' }),
  media_id: z
    .uuid()
    .optional()
    .openapi({
      description:
        'Filter by canonical media id; ids merged into it are matched too. A show id matches all ' +
        'of its episodes and a season id matches that season, so hierarchy refs scope naturally. ' +
        'An id that resolves to nothing yields an empty page, not an error',
    }),
  rating_key: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .openapi({ description: 'Filter by server rating key' }),
  imdb_id: z.string().min(1).max(20).optional().openapi({ example: 'tt1375666' }),
  tmdb_id: z.coerce.number().int().optional(),
  tvdb_id: z.coerce.number().int().optional(),
  media_type: MediaTypeFilterEnum.optional(),
  watched: QueryBoolean.optional().openapi({
    description:
      'Filter by watched state of the play. A play is watched once it crosses the per-media-type completion threshold (default 85%, configurable in settings)',
  }),
  since: QueryDate.optional().openapi({
    description:
      'Plays with a session starting at or after this instant. Accepts a date-only string (midnight UTC) or a full ISO datetime. ' +
      'The window also scopes the aggregation: duration_ms, segment_count and percent_complete cover only in-window segments',
  }),
  until: QueryDate.optional().openapi({
    description:
      'Plays with a session starting at or before this instant. Accepts a date-only string (midnight UTC) or a full ISO datetime. ' +
      'Must not precede since, or the request 400s',
  }),
});

const HistoryUser = z
  .object({
    id: z.uuid().openapi({ description: 'Tracearr identity id' }),
    server_user_id: z.uuid().openapi({ description: "Tracearr's id for this per-server account" }),
    username: z.string().nullable(),
    thumb_url: z.string().nullable(),
    avatar_url: z.string().nullable(),
  })
  .openapi('HistoryUser');

const HistoryRecord = z
  .object({
    id: z.uuid().openapi({ description: 'Chain id: the id of the first session in the play' }),
    server_id: z.uuid(),
    server_name: z.string(),
    server_type: ServerTypeEnum,
    state: z.enum(['playing', 'paused', 'stopped']).openapi({
      description: "The most recent segment's state",
      example: 'stopped',
    }),
    ...mediaMetadataFields,
    duration_ms: z
      .number()
      .int()
      .openapi({ description: 'Watch time summed across all in-window segments of the play' }),
    progress_ms: z.number().int().nullable(),
    total_duration_ms: z.number().int().nullable(),
    percent_complete: z
      .number()
      .nullable()
      .openapi({ description: 'Playback progress as 0-100 with 1 decimal', example: 95.8 }),
    started_at: z.iso.datetime(),
    stopped_at: z.iso.datetime().nullable(),
    watched: z.boolean(),
    segment_count: z
      .number()
      .int()
      .openapi({ description: 'Number of sessions in the resume chain', example: 2 }),
    ...deviceFields,
    ...streamQualityFields,
    ...mediaIdentityFields,
    reference_id: z
      .uuid()
      .openapi({ description: 'Chain key shared by all segments of this play (equals id)' }),
    user: HistoryUser,
  })
  .openapi('HistoryRecord');

const HistoryResponse = z
  .object({
    data: z.array(HistoryRecord),
    meta: CursorMeta,
  })
  .openapi('HistoryResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/history',
  tags: ['Public API v2'],
  summary: 'Watch history as plays',
  description:
    'Cursor-paginated watch history, newest first, one record per play with canonical media ' +
    'identity on every record. ' +
    PLAY_SEMANTICS +
    ' The cursor operates on whole plays, so a chain never splits across pages; pass ' +
    'meta.nextCursor as cursor to fetch the next page. An unreadable cursor returns 400.',
  security: [{ bearerAuth: [] }],
  request: { query: HistoryQuery },
  responses: {
    200: {
      description: 'History retrieved',
      content: { 'application/json': { schema: HistoryResponse } },
    },
    400: { description: 'Invalid query parameters or cursor, or since is after until' },
    ...AUTH_ERROR_RESPONSES,
  },
});

// ============================================================================
// GET /streams
// ============================================================================

const StreamsQuery = z.object({
  server_id: z.uuid().optional().openapi({ description: 'Filter to specific server' }),
  summary: QueryBoolean.optional().openapi({
    description: 'If true, returns only summary stats (omits the data array)',
  }),
});

const ActiveStream = z
  .object({
    id: z.uuid().openapi({ description: 'Session id' }),
    server_id: z.uuid(),
    server_name: z.string(),
    server_type: ServerTypeEnum,
    username: z.string().openapi({
      description: "Identity display name when linked, else the server account's username",
    }),
    user_thumb: z.string().nullable(),
    user_avatar_url: z.string().nullable(),
    ...mediaMetadataFields,
    duration_ms: z.number().int().nullable().openapi({ description: 'Total media length' }),
    state: z.string().openapi({ example: 'playing' }),
    progress_ms: z.number().int(),
    started_at: z.iso.datetime(),
    ...streamQualityFields,
    ...deviceFields,
    ...mediaIdentityFields,
  })
  .openapi('ActiveStream');

const StreamsServerSummary = z
  .object({
    server_id: z.uuid(),
    server_name: z.string(),
    total: z.number().int(),
    transcodes: z.number().int(),
    direct_streams: z.number().int(),
    direct_plays: z.number().int(),
    total_bitrate: z.string().openapi({
      description: "Human-formatted bitrate; an idle server reports '—'",
      example: '45.2 Mbps',
    }),
  })
  .openapi('StreamsServerSummary');

const StreamsSummary = z
  .object({
    total: z.number().int(),
    transcodes: z.number().int(),
    direct_streams: z.number().int(),
    direct_plays: z.number().int(),
    total_bitrate: z.string().openapi({
      description: "Human-formatted bitrate; an idle server reports '—'",
      example: '45.2 Mbps',
    }),
    by_server: z.array(StreamsServerSummary).openapi({
      description: 'Only servers with at least one active session appear',
    }),
  })
  .openapi('StreamsSummary');

const StreamsResponse = z
  .object({
    data: z.array(ActiveStream).optional().openapi({ description: 'Omitted when summary=true' }),
    summary: StreamsSummary,
  })
  .openapi('StreamsResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/streams',
  tags: ['Public API v2'],
  summary: 'Active streams',
  description:
    'Currently active playback sessions, each carrying the same media identity block as ' +
    'history records (canonical media id, provider ids, rating keys, library id, genres). ' +
    'Stopped streams later appear in /history grouped into plays. ' +
    PLAY_SEMANTICS,
  security: [{ bearerAuth: [] }],
  request: { query: StreamsQuery },
  responses: {
    200: {
      description: 'Active streams retrieved',
      content: { 'application/json': { schema: StreamsResponse } },
    },
    400: { description: 'Invalid query parameters' },
    ...AUTH_ERROR_RESPONSES,
  },
});

// ============================================================================
// GET /media/{ref} and /media/{ref}/children
// ============================================================================

const MEDIA_REF_GRAMMAR =
  'ref is a canonical media uuid or a type-qualified provider ref: ' +
  '`{movie|show|episode}:{imdb|tmdb|tvdb}:{id}` (e.g. `movie:tmdb:584`, `show:tvdb:81189`). ' +
  "Seasons have no provider ref; reach a season uuid through a show's children, then pass " +
  'that uuid here. A uuid that was merged into another id resolves to the canonical winner. ' +
  'An unparseable ref, an unknown provider id, or a missing uuid returns 404.';

const MediaRefParam = z.object({
  ref: z.string().openapi({
    param: { name: 'ref', in: 'path' },
    example: 'movie:tmdb:584',
    description: MEDIA_REF_GRAMMAR,
  }),
});

const MediaVersion = z
  .object({
    resolution: z.string().nullable().openapi({ example: '1080p' }),
    video_codec: z.string().nullable().openapi({ example: 'HEVC' }),
    audio_codec: z.string().nullable().openapi({ example: 'EAC3' }),
    dynamic_range: z.string().nullable().openapi({ example: 'hdr10' }),
    container: z.string().nullable().openapi({ example: 'mkv' }),
    file_size: z.number().int().nullable().openapi({ description: 'Bytes for this file' }),
  })
  .openapi('MediaVersion');

const MediaAvailability = z
  .object({
    server_id: z.uuid(),
    server_type: ServerTypeEnum,
    library_id: z.string().openapi({ description: "The server's library identifier" }),
    rating_key: z.string().openapi({ description: 'Server-specific media id' }),
    added_at: z.iso.datetime().openapi({ description: 'Server-reported added date' }),
    removed_at: z.iso
      .datetime()
      .nullable()
      .openapi({ description: 'Set when the item was removed from the server; null when present' }),
    video_resolution: z
      .string()
      .nullable()
      .openapi({
        description:
          "The best version's resolution as a lowercase token (8k, 4k, 1440p, 1080p, 720p, " +
          '480p, sd; unrecognized server labels pass through verbatim). Null on show rows, ' +
          'which carry no file of their own',
        example: '4k',
      }),
    file_size: z
      .number()
      .int()
      .nullable()
      .openapi({
        description:
          "Bytes, summed across the copy's active versions. Null on show rows. A removed copy " +
          '(removed_at set) keeps its last-known size while its versions list is empty',
      }),
    versions: z.array(MediaVersion).openapi({
      description:
        'Physical files of this copy, largest first. A freshly-migrated item shows one ' +
        'placeholder version mirroring the flat fields until its next full library sync',
    }),
  })
  .openapi('MediaAvailability');

const MediaResource = z
  .object({
    id: z.uuid().openapi({ description: 'Canonical media id' }),
    media_type: z.string().openapi({ example: 'movie' }),
    title: z.string(),
    year: z.number().int().nullable(),
    imdb_id: z.string().nullable().openapi({ example: 'tt1375666' }),
    tmdb_id: z.number().int().nullable(),
    tvdb_id: z.number().int().nullable(),
    genres: z.array(z.string()).nullable(),
    show_media_id: z
      .uuid()
      .nullable()
      .openapi({ description: 'Canonical id of the parent show (seasons and episodes)' }),
    merged_ids: z
      .array(z.uuid())
      .openapi({ description: 'Other media ids that were merged into this one' }),
    availability: z
      .array(MediaAvailability)
      .openapi({ description: 'One entry per server library row, tombstones included' }),
    season_count: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Shows only: seasons with at least one non-removed library item' }),
    episode_count: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Shows only: episodes with at least one non-removed library item' }),
  })
  .openapi('MediaResource');

const MediaChild = z
  .object({
    id: z.uuid(),
    media_type: z.enum(['season', 'episode']),
    title: z.string(),
    season_number: z.number().int().nullable().openapi({ description: 'Seasons only' }),
    episode_count: z.number().int().nullable().openapi({ description: 'Seasons only' }),
    episode_number: z.number().int().nullable().openapi({ description: 'Episodes only' }),
    imdb_id: z.string().nullable().openapi({ description: 'Episodes only' }),
    tmdb_id: z.number().int().nullable().openapi({ description: 'Episodes only' }),
    tvdb_id: z.number().int().nullable().openapi({ description: 'Episodes only' }),
    show_media_id: z.uuid().nullable(),
    genres: z.array(z.string()).nullable(),
  })
  .openapi('MediaChild');

const MediaChildrenResponse = z
  .object({ data: z.array(MediaChild) })
  .openapi('MediaChildrenResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/media/{ref}',
  tags: ['Public API v2'],
  summary: 'Media identity and availability',
  description:
    'Resolves a media ref to its canonical identity, the ids merged into it, and per-server ' +
    'availability (including removed copies). Shows also carry season and episode counts. ' +
    MEDIA_REF_GRAMMAR,
  security: [{ bearerAuth: [] }],
  request: { params: MediaRefParam },
  responses: {
    200: {
      description: 'Media resolved',
      content: { 'application/json': { schema: MediaResource } },
    },
    ...AUTH_ERROR_RESPONSES,
    404: { description: 'No media matches the ref' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/media/{ref}/children',
  tags: ['Public API v2'],
  summary: 'Media children',
  description:
    "Lists a show's seasons (with per-season episode counts) or a season's episodes. Season " +
    'refs are uuid-only, so a script goes show ref → children → season uuid → children. Movie ' +
    'and episode refs have no children and return 404. ' +
    MEDIA_REF_GRAMMAR,
  security: [{ bearerAuth: [] }],
  request: { params: MediaRefParam },
  responses: {
    200: {
      description: 'Children retrieved',
      content: { 'application/json': { schema: MediaChildrenResponse } },
    },
    ...AUTH_ERROR_RESPONSES,
    404: {
      description:
        'Ref is unknown or has no children. A season whose number cannot be derived returns ' +
        '200 with an empty list instead',
    },
  },
});

// ============================================================================
// GET /media/{ref}/stats, /watchers, /history
// ============================================================================

const WINDOW_SEMANTICS =
  'Windows are UTC calendar days: `last_7` and `last_30` cover the 7 or 30 most recent UTC ' +
  'days including today (day >= current UTC date - N + 1). Responses are cached for 60 seconds.';

const StatMeasures = z.object({
  plays: z
    .number()
    .int()
    .openapi({
      description:
        'Resume chains whose first session reached 2 minutes, from the daily rollup. Plays on ' +
        'media Tracearr could not identify are not counted. Season refs compute live from ' +
        'sessions instead and count a chain when ANY segment reaches 2 minutes, so a season ' +
        'total can exceed the sum of its episodes',
    }),
  watch_time_ms: z.number().int().openapi({
    description: 'Milliseconds summed across sessions that individually reached 2 minutes',
  }),
  unique_users: z
    .number()
    .int()
    .openapi({
      description:
        'Distinct Tracearr identities with at least 2 minutes watched; one person on many ' +
        'servers counts once. Can exceed what plays implies, since a chain only counts as a ' +
        'play when its first session qualifies',
    }),
});

const StatServerMeasures = z
  .object({
    server_id: z.uuid(),
    server_name: z.string().nullable(),
    plays: z.number().int(),
    watch_time_ms: z.number().int(),
    unique_users: z.number().int(),
  })
  .openapi('StatServerMeasures');

const StatWindow = z
  .object({
    combined: StatMeasures,
    per_server: z.array(StatServerMeasures),
  })
  .openapi('StatWindow');

const MediaStatsResponse = z
  .object({
    media_id: z.uuid(),
    media_type: z.string().openapi({ example: 'movie' }),
    windows: z.object({
      all_time: StatWindow,
      last_30: StatWindow,
      last_7: StatWindow,
    }),
  })
  .openapi('MediaStatsResponse');

const WatcherUser = z
  .object({
    server_user_id: z.uuid(),
    user_id: z.uuid().openapi({ description: 'Tracearr identity id' }),
    username: z.string().nullable().openapi({ description: 'Account name on the server' }),
    identity_name: z.string().nullable().openapi({ description: 'Identity display name' }),
  })
  .openapi('WatcherUser');

const Watcher = z
  .object({
    user: WatcherUser,
    plays: z.number().int(),
    watch_time_ms: z.number().int(),
    completion_pct: z
      .number()
      .nullable()
      .openapi({ description: 'Max progress vs content duration, 0-100, capped', example: 96.4 }),
    last_watched_day: z.string().nullable().openapi({ description: 'UTC date, YYYY-MM-DD' }),
    distinct_episodes_watched: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Shows and seasons only; null for movies and episodes' }),
  })
  .openapi('Watcher');

const MediaWatchersResponse = z
  .object({
    media_id: z.uuid(),
    media_type: z.string(),
    window: z.enum(['all_time', 'last_30', 'last_7']),
    watchers: z.array(Watcher),
  })
  .openapi('MediaWatchersResponse');

const WatchersQuery = z.object({
  window: z
    .enum(['all_time', 'last_30', 'last_7'])
    .default('all_time')
    .openapi({ description: 'UTC calendar window (default all_time)' }),
  server_id: z.uuid().optional().openapi({ description: 'Filter to a single server' }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/media/{ref}/stats',
  tags: ['Public API v2'],
  summary: 'Media play statistics',
  description:
    'Play counts, watch time, and distinct viewers for a media item across all_time, last_30, ' +
    'and last_7 windows, each with a combined total and a per-server breakdown. Movies and ' +
    'episodes roll up by canonical media id; shows roll up their episodes; seasons compute live ' +
    'from raw sessions. ' +
    WINDOW_SEMANTICS +
    ' ' +
    MEDIA_REF_GRAMMAR,
  security: [{ bearerAuth: [] }],
  request: { params: MediaRefParam },
  responses: {
    200: {
      description: 'Statistics retrieved',
      content: { 'application/json': { schema: MediaStatsResponse } },
    },
    ...AUTH_ERROR_RESPONSES,
    404: { description: 'No media matches the ref' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/media/{ref}/watchers',
  tags: ['Public API v2'],
  summary: 'Media watchers',
  description:
    'One entry per server account that watched the item, ordered by watch time. Movies and ' +
    'episodes roll up by canonical media id; shows roll up their episodes; seasons compute live ' +
    'from raw sessions. ' +
    WINDOW_SEMANTICS +
    ' ' +
    MEDIA_REF_GRAMMAR,
  security: [{ bearerAuth: [] }],
  request: { params: MediaRefParam, query: WatchersQuery },
  responses: {
    200: {
      description: 'Watchers retrieved',
      content: { 'application/json': { schema: MediaWatchersResponse } },
    },
    400: { description: 'Invalid query parameters' },
    ...AUTH_ERROR_RESPONSES,
    404: { description: 'No media matches the ref' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/media/{ref}/history',
  tags: ['Public API v2'],
  summary: 'Media watch history',
  description:
    'Cursor-paginated watch history for a single media item, newest first, one record per play. ' +
    'Scoped to the item and any ids merged into it; shows include every episode, seasons the ' +
    'episodes of that season. ' +
    PLAY_SEMANTICS +
    ' ' +
    MEDIA_REF_GRAMMAR,
  security: [{ bearerAuth: [] }],
  request: {
    params: MediaRefParam,
    query: z.object({
      cursor: z.string().optional().openapi({ description: 'Opaque cursor from meta.nextCursor' }),
      pageSize: z.coerce.number().int().positive().max(100).default(25),
    }),
  },
  responses: {
    200: {
      description: 'History retrieved',
      content: { 'application/json': { schema: HistoryResponse } },
    },
    400: { description: 'Invalid query parameters or cursor' },
    ...AUTH_ERROR_RESPONSES,
    404: { description: 'No media matches the ref' },
  },
});

// ============================================================================
// GET /users, /users/{id}, /users/{id}/stats, /users/{id}/history
// ============================================================================

const CORRELATION_NOTE =
  "Correlation is Tracearr-side. Media servers do not expose their users' email addresses, so " +
  '`email` here is the email held on the Tracearr identity (null when unset). `external_user_id` ' +
  "is the media server's own user identifier (Plex numeric account id, Emby/Jellyfin user GUID); " +
  'it is the stable key integrators should correlate on. One identity can own accounts on several ' +
  'servers; those rows are collapsed to a single identity here.';

const UserAccount = z
  .object({
    server_id: z.uuid(),
    server_type: ServerTypeEnum,
    server_user_id: z.uuid().openapi({ description: "Tracearr's id for this per-server account" }),
    external_user_id: z
      .string()
      .openapi({ description: "The media server's own user identifier", example: '1234567' }),
    username: z.string().openapi({ description: 'Account name on that server' }),
    removed_at: z.iso
      .datetime()
      .nullable()
      .openapi({ description: 'Set when the account no longer exists on the server' }),
  })
  .openapi('UserAccount');

const UserIdentity = z
  .object({
    id: z.uuid().openapi({ description: 'Tracearr identity id' }),
    username: z.string(),
    email: z.string().nullable().openapi({ description: 'Tracearr identity email' }),
    plex_account_id: z.string().nullable().openapi({ description: 'Linked Plex.tv account id' }),
    accounts: z.array(UserAccount),
  })
  .openapi('UserIdentity');

const UsersResponse = z
  .object({ data: z.array(UserIdentity), meta: CursorMeta })
  .openapi('UsersResponse');

const UsersQuery = z.object({
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from meta.nextCursor' }),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  include_removed: QueryBoolean.optional().openapi({
    description:
      'Include identities whose every account has been removed. Defaults to false. Identities ' +
      'with no media-server account at all never appear here (fetch them by id instead)',
    default: false,
  }),
});

const UserIdParam = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' }, description: 'Tracearr identity id' }),
});

const UserStatWindow = z.object({
  plays: z
    .number()
    .int()
    .openapi({
      description:
        'Resume chains whose first session reached 2 minutes, from the daily rollup. Plays on ' +
        'media Tracearr could not identify are not counted',
    }),
  watch_time_ms: z.number().int().openapi({
    description: 'Milliseconds summed across sessions that individually reached 2 minutes',
  }),
});

const UserGenre = z
  .object({
    genre: z.string().openapi({ example: 'Action' }),
    plays: z.number().int(),
  })
  .openapi('UserGenre');

const UserStatsResponse = z
  .object({
    user_id: z.uuid(),
    windows: z.object({
      all_time: UserStatWindow,
      last_30: UserStatWindow,
      last_7: UserStatWindow,
    }),
    top_genres: z.array(UserGenre).openapi({
      description:
        'Most-played genres across the identity, top 10 by play count. All-time regardless of ' +
        'the windows; a multi-genre title contributes its plays to each of its genres',
    }),
  })
  .openapi('UserStatsResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/users',
  tags: ['Public API v2'],
  summary: 'Identities with account correlation',
  description:
    'Cursor-paginated Tracearr identities, newest first, each with the media-server accounts it ' +
    'owns. ' +
    CORRELATION_NOTE,
  security: [{ bearerAuth: [] }],
  request: { query: UsersQuery },
  responses: {
    200: {
      description: 'Identities retrieved',
      content: { 'application/json': { schema: UsersResponse } },
    },
    400: { description: 'Invalid query parameters or cursor' },
    ...AUTH_ERROR_RESPONSES,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/users/{id}',
  tags: ['Public API v2'],
  summary: 'One identity',
  description: 'Resolves a Tracearr identity id to its correlation block. ' + CORRELATION_NOTE,
  security: [{ bearerAuth: [] }],
  request: { params: UserIdParam },
  responses: {
    200: {
      description: 'Identity retrieved',
      content: { 'application/json': { schema: UserIdentity } },
    },
    400: { description: 'id is not a valid uuid' },
    ...AUTH_ERROR_RESPONSES,
    404: { description: 'No identity matches the id' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/users/{id}/stats',
  tags: ['Public API v2'],
  summary: 'Identity play statistics',
  description:
    'Plays and watch time for an identity, summed across every account it owns, over all_time, ' +
    'last_30, and last_7 UTC-day windows, plus its top genres by play count. ' +
    WINDOW_SEMANTICS,
  security: [{ bearerAuth: [] }],
  request: { params: UserIdParam },
  responses: {
    200: {
      description: 'Statistics retrieved',
      content: { 'application/json': { schema: UserStatsResponse } },
    },
    400: { description: 'id is not a valid uuid' },
    ...AUTH_ERROR_RESPONSES,
    404: { description: 'No identity matches the id' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/users/{id}/history',
  tags: ['Public API v2'],
  summary: 'Identity watch history',
  description:
    'Cursor-paginated watch history for an identity, newest first, one record per play, scoped ' +
    'to every account the identity owns. ' +
    PLAY_SEMANTICS,
  security: [{ bearerAuth: [] }],
  request: {
    params: UserIdParam,
    query: z.object({
      cursor: z.string().optional().openapi({ description: 'Opaque cursor from meta.nextCursor' }),
      pageSize: z.coerce.number().int().positive().max(100).default(25),
    }),
  },
  responses: {
    200: {
      description: 'History retrieved',
      content: { 'application/json': { schema: HistoryResponse } },
    },
    400: { description: 'Invalid query parameters or cursor' },
    ...AUTH_ERROR_RESPONSES,
    404: { description: 'No identity matches the id' },
  },
});

// ============================================================================
// GET /recently-added
// ============================================================================

const RecentlyAddedQuery = z.object({
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from meta.nextCursor' }),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  server_id: z.uuid().optional().openapi({ description: 'Filter to specific server' }),
  library_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .openapi({ description: "Filter to a server's library id" }),
  media_type: z
    .enum(['movie', 'episode', 'season', 'show', 'artist', 'album', 'track', 'photo'])
    .optional()
    .openapi({ description: 'Filter by library item type' }),
  include_removed: QueryBoolean.optional().openapi({
    description: 'Include items removed from the server (tombstones)',
  }),
});

const RecentlyAddedRecord = z
  .object({
    id: z.uuid().openapi({ description: 'Library item id' }),
    server_id: z.uuid(),
    server_type: ServerTypeEnum,
    library_id: z.string().openapi({ description: "The server's library identifier" }),
    media_type: z.string().openapi({ example: 'movie' }),
    title: z.string().openapi({ example: 'Inception' }),
    year: z.number().int().nullable().openapi({ example: 2010 }),
    added_at: z.iso.datetime().openapi({ description: 'Server-reported added date' }),
    removed_at: z.iso
      .datetime()
      .nullable()
      .openapi({ description: 'Set when the item was removed from the server; null when present' }),
    media_id: z
      .uuid()
      .nullable()
      .openapi({ description: 'Canonical media id, shared across servers' }),
    imdb_id: z.string().nullable().openapi({ example: 'tt1375666' }),
    tmdb_id: z.number().int().nullable().openapi({ example: 27205 }),
    tvdb_id: z.number().int().nullable(),
    rating_key: z.string().nullable().openapi({
      description: 'Server-specific media id; null when the server never provided one',
    }),
    parent_rating_key: z.string().nullable(),
    grandparent_rating_key: z.string().nullable(),
  })
  .openapi('RecentlyAddedRecord');

const RecentlyAddedResponse = z
  .object({ data: z.array(RecentlyAddedRecord), meta: CursorMeta })
  .openapi('RecentlyAddedResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/recently-added',
  tags: ['Public API v2'],
  summary: 'Recently added library items',
  description:
    'Cursor-paginated library items ordered by server-reported added date, newest first, each ' +
    'with its media identity block. Removed items are excluded unless include_removed is set. ' +
    'The cursor pages on the whole (added_at, id) tuple, so items sharing an added timestamp ' +
    '(the common case after a bulk sync) page without skips or duplicates.',
  security: [{ bearerAuth: [] }],
  request: { query: RecentlyAddedQuery },
  responses: {
    200: {
      description: 'Items retrieved',
      content: { 'application/json': { schema: RecentlyAddedResponse } },
    },
    400: { description: 'Invalid query parameters or cursor' },
    ...AUTH_ERROR_RESPONSES,
  },
});

// ============================================================================
// GET /libraries
// ============================================================================

const LibraryRollup = z
  .object({
    server_id: z.uuid(),
    server_type: ServerTypeEnum,
    library_id: z.string().openapi({ description: "The server's library identifier" }),
    item_count: z.number().int().openapi({
      description: 'Total items in the library; season container rows are excluded',
    }),
    movie_count: z.number().int(),
    episode_count: z.number().int(),
    show_count: z.number().int(),
    track_count: z.number().int(),
    total_file_size: z
      .number()
      .int()
      .openapi({
        description:
          'Bytes across every version of every title: a title held in both 4K and 1080p ' +
          'contributes both files',
      }),
    resolutions: z.record(z.string(), z.number().int()).openapi({
      description:
        'Titles per resolution, each counted once at its best version (a 4K+1080p pair lands ' +
        'only in 4k). Keys are lowercase tokens; containers and items with no recorded ' +
        'resolution key as "unknown"',
    }),
  })
  .openapi('LibraryRollup');

const LibrariesResponse = z.object({ data: z.array(LibraryRollup) }).openapi('LibrariesResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/libraries',
  tags: ['Public API v2'],
  summary: 'Per-library rollups',
  description:
    'Item, movie, episode, show, and track counts, total file size, and per-resolution counts ' +
    'for each server library. Items removed from the server are excluded. Cached for 60 seconds.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Rollups retrieved',
      content: { 'application/json': { schema: LibrariesResponse } },
    },
    ...AUTH_ERROR_RESPONSES,
  },
});

// ============================================================================
// Document Generator
// ============================================================================

// ============================================================================
// GET /watched-media
// ============================================================================

const WatchedStateEnum = z.enum(['watched', 'partial', 'unwatched']);

const WatchedMediaQuery = z.object({
  media_type: z.enum(['movie', 'show', 'episode']).openapi({
    description:
      'Which rollup to list. movie and episode key on the media itself; show rolls its ' +
      'episodes up through show_media_id',
  }),
  user_id: z
    .uuid()
    .optional()
    .openapi({
      description:
        'Scope every row to one identity, as on /history. Omit it and the response describes ' +
        'the whole install. A title this identity never played is absent rather than returned ' +
        'as unwatched, so watched_state, plays, last_watched_day and episodes_watched all ' +
        'describe that identity alone. episode_count stays server-wide, so a scoped show is ' +
        'watched once that identity has seen every episode present on the server',
    }),
  server_id: z.uuid().optional().openapi({ description: 'Filter to specific server' }),
  min_state: z
    .enum(['watched', 'partial'])
    .default('watched')
    .openapi({
      description:
        'Lowest state to include, at whatever grain user_id set. "partial" also returns ' +
        'titles started but not finished',
    }),
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from meta.nextCursor' }),
  pageSize: z.coerce.number().int().positive().max(1000).default(100),
});

const WatchedMediaRecord = z
  .object({
    media_id: z.uuid().openapi({ description: 'Canonical media id; merge losers resolve to it' }),
    media_type: z.string().openapi({ example: 'movie' }),
    title: z.string().openapi({ example: 'Inception' }),
    year: z.number().int().nullable().openapi({ example: 2010 }),
    imdb_id: z.string().nullable().openapi({ example: 'tt1375666' }),
    tmdb_id: z.number().int().nullable().openapi({ example: 27205 }),
    tvdb_id: z.number().int().nullable(),
    show_media_id: z
      .uuid()
      .nullable()
      .openapi({ description: 'Episode rows only: the series this episode belongs to' }),
    show_title: z.string().nullable(),
    show_imdb_id: z.string().nullable(),
    show_tmdb_id: z.number().int().nullable(),
    show_tvdb_id: z.number().int().nullable().openapi({
      description: "Episode rows only: the series' tvdb id, since tvdb_id is the episode's own",
    }),
    season_number: z
      .number()
      .int()
      .nullable()
      .openapi({
        description:
          'Episode rows only: season number. An episode carries a provider id of its own only ' +
          'when the media server supplied one, so this and episode_number are the reliable way ' +
          'to place an episode within show_tvdb_id',
      }),
    episode_number: z.number().int().nullable().openapi({
      description: 'Episode rows only: episode number within the season',
    }),
    watched_state: WatchedStateEnum.openapi({
      description:
        'Watched or partial, for the user_id identity when one was given and across every ' +
        'identity otherwise. Never unwatched: an unwatched title is simply absent',
    }),
    plays: z.number().int().openapi({ description: 'Plays at the same grain as watched_state' }),
    last_watched_day: z.string().openapi({
      description:
        'Most recent UTC day with activity, YYYY-MM-DD (the rollup buckets by day). Filter on ' +
        'this client-side for a recent-activity view',
      example: '2026-08-30',
    }),
    episodes_watched: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Show rows only: distinct episodes watched, at the same grain' }),
    episode_count: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Show rows only: episodes present on the server' }),
  })
  .openapi('WatchedMediaRecord');

const WatchedMediaResponse = z
  .object({ data: z.array(WatchedMediaRecord), meta: CursorMeta })
  .openapi('WatchedMediaResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/watched-media',
  tags: ['Public API v2'],
  summary: 'Watched media set',
  description:
    'The distinct set of media with recorded engagement, newest activity first, for matching ' +
    'against an external library by tmdb/tvdb/imdb id. Absence from the result means ' +
    'unwatched, so an unwatched title is never returned. A movie is watched once a play passed ' +
    "this server's watch-completion threshold (85% of runtime by default, configurable per " +
    'media type in Settings); a show is watched once every episode present on the server has ' +
    'been. A show with no episodes on any server is treated as unwatched and omitted. ' +
    'To distinguish "this person watched it" from "somebody else did", pull twice, once with ' +
    'user_id and once without: the scoped result is always a subset of the unscoped one, and ' +
    'the difference is what other people watched. The matching set is computed once per filter ' +
    'combination and cached for 60 seconds, and every page of a walk reads that same snapshot.',
  security: [{ bearerAuth: [] }],
  request: { query: WatchedMediaQuery },
  responses: {
    200: {
      description: 'Watched media retrieved',
      content: { 'application/json': { schema: WatchedMediaResponse } },
    },
    400: { description: 'Invalid query parameters or cursor' },
    ...AUTH_ERROR_RESPONSES,
  },
});

export function generateOpenAPIDocumentV2(): unknown {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Tracearr Public API',
      version: '2.0.0',
      description: `
External API for third-party integrations (version 2).

Available in Tracearr 2.0.0 and later. Earlier versions serve API v1 only.

## Authentication

All endpoints require Bearer token authentication:

\`\`\`
Authorization: Bearer trr_pub_<your_token>
\`\`\`

Generate your API key in **Settings > General**.

## Pagination

The history, users, recently-added, and watched-media endpoints use cursor pagination via
\`cursor\` and \`pageSize\`. Most cap pageSize at 100 with a default of 25; watched-media
carries far smaller rows and allows up to 1000, defaulting to 100. Each paginated response
carries a \`meta.nextCursor\` to fetch the following page. Streams and libraries return the
full set in one response.

## Filtering

History, streams, watchers, recently-added, and watched-media accept \`server_id\` to filter
by media server.
      `.trim(),
      contact: {
        name: 'Tracearr',
        url: 'https://github.com/connorgallopo/Tracearr',
      },
    },
  });
}
