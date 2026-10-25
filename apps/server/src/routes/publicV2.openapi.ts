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
  description: 'API key format: trr_pub_<token>. Generate in Settings > Data & API > API.',
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
    description:
      "Rate limit exceeded for this key's shared budget across the whole v2 surface, or (events only) the key or the server already holds its maximum number of open event connections; Retry-After says when to try again",
  },
} as const;

// ============================================================================
// Tags
//
// One tag per resource, in sidebar order. Each path carries exactly one of
// these; the document's tags array below gives Scalar the order and the text.
// ============================================================================

const V2_TAGS = [
  { name: 'Docs', description: 'This document.' },
  {
    name: 'Streams',
    description: 'What is playing right now on every server, read from the session cache.',
  },
  {
    name: 'Live events',
    description:
      'One open connection that receives stream, violation and server health events as they happen. Read the Live events section above before integrating.',
  },
  {
    name: 'Violations',
    description:
      'Violations as the Violations page shows them, newest first: completed policy automation runs that have an account and were not dismissed. Each row has the shape `violation.created` pushes, and `rule` is the automation that produced it.',
  },
  {
    name: 'Servers',
    description:
      'Every configured media server with its health: up while Tracearr holds a live connection to it or polling reaches it, down after consecutive poll failures, or with Session Sync turned off once its live connection has been down for a minute, unknown when Tracearr has nothing recent to go on.',
  },
  {
    name: 'History',
    description: 'Watch history as plays (resume chains) across every server, with media identity.',
  },
  {
    name: 'Media',
    description:
      'Canonical titles across servers: identity and hierarchy, per-server availability, stats, watchers, per-title history, and the watched set.',
  },
  {
    name: 'Users',
    description:
      'Tracearr identities and the per-server accounts behind them, with stats and history.',
  },
  {
    name: 'Libraries',
    description: 'Per-library rollups and what was recently added to them.',
  },
] as const;

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
  tags: ['Docs'],
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
  'reference_id IS NULL marks the chain start. A chain counts once when any of its sessions ' +
  'reaches 2 minutes or passes the watched threshold for its media type ' +
  '(COALESCE(duration_ms, 0) >= 120000 OR watched), including a chain that crosses UTC ' +
  'midnight. Rating keys the media server never provided are returned as null.';

const ServerTypeEnum = z.enum(['plex', 'jellyfin', 'emby']);
const MediaTypeEnum = z.enum(['movie', 'episode', 'track', 'live', 'photo', 'trailer', 'unknown']);
const TranscodeDecisionEnum = z.enum(['directplay', 'copy', 'transcode']);
const ActiveStateEnum = z.enum(['playing', 'paused']).openapi({
  description: 'A stream that stops leaves /streams and sends stream.stopped instead',
  example: 'playing',
});

const SERVER_ID = '5c1a4c1e-0b2d-4f6a-9d3e-2b7c8f9a1d20';
const STREAM_ID = '0f4d2a6e-8b1c-4e3f-9a7d-6c5b4a3f2e1d';

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
  is_transcode: z
    .boolean()
    .openapi({ description: 'True when the server reports the session as a transcode' }),
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
  resolution: z
    .string()
    .nullable()
    .openapi({ description: 'Source resolution label from width and height', example: '4K' }),
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
  media_type: MediaTypeEnum.optional().openapi({
    description: 'Filter by media type. Trailers are left out unless you ask for trailer',
  }),
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
  tags: ['History'],
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
    user_thumb: z.string().nullable().openapi({ description: 'Avatar as the server reports it' }),
    user_avatar_url: z.string().nullable().openapi({ description: 'Proxied avatar URL' }),
    ...mediaMetadataFields,
    duration_ms: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Total media length in milliseconds' }),
    state: ActiveStateEnum,
    progress_ms: z.number().int().openapi({ description: 'Playback position in milliseconds' }),
    started_at: z.iso.datetime().openapi({ description: 'When the stream began' }),
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
    audio_transcodes: z
      .number()
      .int()
      .openapi({ description: 'Of the transcodes, those where only the audio is transcoded' }),
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
    audio_transcodes: z
      .number()
      .int()
      .openapi({ description: 'Of the transcodes, those where only the audio is transcoded' }),
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
  tags: ['Streams'],
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
// GET /violations and /violations/{id}
// ============================================================================

const VIOLATION_SEMANTICS =
  'A violation is a completed policy automation run with an account that has not been ' +
  'dismissed: the rows the Violations page shows. Acknowledging stamps acknowledged_at and ' +
  'changes nothing else. Dismissing removes the row from every list and reverses the trust ' +
  'adjustments its actions made, so a dismissed violation 404s by id. Completed session ' +
  "violations are purged after the automation's retention (365 days by default).";

const ViolationsQuery = z.object({
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from meta.nextCursor' }),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  server_id: z.uuid().optional().openapi({ description: 'Filter to specific server' }),
  user_id: z.uuid().optional().openapi({
    description: 'Filter by Tracearr identity id; matches every account linked to that identity',
  }),
  server_user_id: z.uuid().optional().openapi({
    description: 'Filter by one per-server account, the user.server_user_id of a row',
  }),
  rule_id: z.uuid().optional().openapi({
    description: 'Filter by the automation that recorded the violation, the rule.id of a row',
  }),
  severity: z.enum(['low', 'warning', 'high']).optional(),
  acknowledged: QueryBoolean.optional().openapi({
    description: 'true for acknowledged violations only, false for pending ones only',
  }),
  since: QueryDate.optional().openapi({
    description:
      'Violations recorded at or after this instant. Accepts a date-only string (midnight UTC) or a full ISO datetime',
  }),
  until: QueryDate.optional().openapi({
    description:
      'Violations recorded at or before this instant. Must not precede since, or the request 400s',
  }),
});

const ViolationUser = z
  .object({
    id: z
      .uuid()
      .openapi({ description: 'Tracearr identity id, the same id /users and /history use' }),
    server_user_id: z.uuid().openapi({ description: "Tracearr's id for the per-server account" }),
    username: z.string().openapi({
      description: 'The identity display name when it has one, else the account name on the server',
    }),
    thumb_url: z.string().nullable().openapi({ description: 'Avatar as the server reports it' }),
    avatar_url: z.string().nullable().openapi({ description: 'Proxied avatar URL' }),
  })
  .openapi('ViolationUser');

const VIOLATION_EXAMPLE = {
  id: 'c7e1f9a3-5d2b-4c8e-a1f6-3b9d7e2c5a84',
  severity: 'high',
  created_at: '2026-10-06T10:00:05.000Z',
  acknowledged_at: null,
  session_id: STREAM_ID,
  rule: { id: '2a8f4c6e-1b3d-4e5f-9c7a-8d6b5e4f3a21', name: 'Too many streams' },
  server: { id: SERVER_ID, name: 'Attic', type: 'plex' },
  user: {
    id: '9b2d4f6e-8a0c-4e1f-b3d5-7a9c1e3f5b70',
    server_user_id: '7d3b9f1e-4a6c-4d2e-8b5f-1c9a7e3d5b60',
    username: 'Alice',
    thumb_url: 'https://plex.tv/users/8f3a1c/avatar',
    avatar_url: 'https://plex.tv/users/8f3a1c/avatar',
  },
  data: {
    evidence: [
      {
        groupIndex: 0,
        matched: true,
        match: 'all',
        conditions: [
          {
            field: 'concurrent_streams',
            operator: 'gt',
            threshold: 2,
            actual: 3,
            matched: true,
            relatedSessionIds: [
              '4e9b7c2a-6d1f-4a3e-8c5b-9f2d7e1a6c43',
              'a1c3e5f7-9b2d-4e6f-8a0c-2d4f6e8a0b1c',
            ],
          },
        ],
      },
    ],
    relatedSessionIds: [
      '4e9b7c2a-6d1f-4a3e-8c5b-9f2d7e1a6c43',
      'a1c3e5f7-9b2d-4e6f-8a0c-2d4f6e8a0b1c',
    ],
    ruleName: 'Too many streams',
    matchedGroups: [0],
    triggerId: 'n1',
    edgeKey: null,
    sessionKey: '7f0c1d2e',
    mediaTitle: 'Inception',
    ipAddress: '203.0.113.9',
  },
};

const Violation = z
  .object({
    id: z.uuid().openapi({ description: 'Violation id' }),
    severity: z
      .enum(['low', 'warning', 'high'])
      .openapi({ description: 'Severity set on the automation' }),
    created_at: z.iso.datetime().openapi({ description: 'When the violation was recorded' }),
    acknowledged_at: z.iso.datetime().nullable().openapi({
      description:
        'When an owner acknowledged it; null while pending, and always null on violation.created',
    }),
    session_id: z.uuid().nullable().openapi({
      description:
        'The stream that triggered the automation; null for account rules such as inactivity. The session may since have left /streams and /history',
    }),
    rule: z
      .object({
        id: z.uuid().openapi({ description: "The automation's id" }),
        name: z.string().openapi({ description: 'Automation name as shown in Tracearr' }),
      })
      .openapi({
        description:
          'The automation that produced this violation. Tracearr labels it Rule on the Violations page; rule.id is the automation id',
      }),
    server: z.object({
      id: z.uuid().openapi({ description: 'Server the account belongs to' }),
      name: z.string().openapi({ description: 'Server name as set in Tracearr' }),
      type: ServerTypeEnum,
    }),
    user: ViolationUser,
    data: z.record(z.string(), z.unknown()).openapi({
      description:
        'What the automation recorded when it fired. Current automations write evidence (each condition group with its conditions, the field, operator, threshold and actual value), relatedSessionIds, ruleName, matchedGroups, the triggerId and edgeKey of the trigger node, and for a session-scoped rule its sessionKey, mediaTitle and ipAddress. Violations recorded before Tracearr 1.4.18 carry whatever their rule stored at the time, which may be none of these keys. Condition fields vary by rule, so treat the keys inside evidence as free-form',
    }),
  })
  .openapi('Violation', { example: VIOLATION_EXAMPLE });

const ViolationAction = z
  .object({
    type: z
      .string()
      .openapi({ description: 'Action type as the automation names it', example: 'kill_stream' }),
    success: z.boolean(),
    skipped: z
      .boolean()
      .openapi({ description: 'True when the action was not attempted, with skip_reason' }),
    skip_reason: z.string().nullable(),
    error_message: z.string().nullable(),
    executed_at: z.iso.datetime(),
  })
  .openapi('ViolationAction');

const ViolationDetail = Violation.extend({
  actions: z.array(ViolationAction).openapi({
    description:
      'The actions the automation ran for this violation, oldest first. Actions run after the violation is recorded, so violation.created never carries them',
  }),
}).openapi('ViolationDetail');

const ViolationsResponse = z
  .object({ data: z.array(Violation), meta: CursorMeta })
  .openapi('ViolationsResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/violations',
  tags: ['Violations'],
  summary: 'Violations',
  description:
    'Violations newest first, in the same shape violation.created pushes, so a list fetched ' +
    'on ready and the events after it are one stream of objects. ' +
    VIOLATION_SEMANTICS,
  security: [{ bearerAuth: [] }],
  request: { query: ViolationsQuery },
  responses: {
    200: {
      description: 'Violations retrieved',
      content: { 'application/json': { schema: ViolationsResponse } },
    },
    400: { description: 'Invalid query parameters or cursor' },
    ...AUTH_ERROR_RESPONSES,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/violations/{id}',
  tags: ['Violations'],
  summary: 'One violation with its actions',
  description:
    'The same row GET /violations returns, plus the actions the automation ran. ' +
    VIOLATION_SEMANTICS,
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Violation retrieved',
      content: { 'application/json': { schema: ViolationDetail } },
    },
    400: { description: 'id is not a uuid' },
    404: { description: 'No violation with this id: unknown, dismissed, or not a violation' },
    ...AUTH_ERROR_RESPONSES,
  },
});

// ============================================================================
// GET /servers
// ============================================================================

const ServerStatusEnum = z.enum(['up', 'down', 'unknown']).openapi({
  description:
    'up while Tracearr holds a live event connection to the server, or while polling reaches it. ' +
    'down once three consecutive polls have failed, or with Session Sync turned off, once its ' +
    'live connection has been down for a minute. unknown when the server ' +
    'is historical, or when it has no live connection and no poll has completed in the last ' +
    'ten minutes',
});

const Server = z
  .object({
    server_id: z.uuid(),
    server_name: z
      .string()
      .openapi({ description: 'Server name as set in Tracearr', example: 'Attic' }),
    status: ServerStatusEnum,
    reason: z.enum(['unauthorized']).nullable().openapi({
      description:
        'Why the server is down when Tracearr knows: unauthorized means the stored credentials were rejected. Null otherwise',
    }),
    server_type: ServerTypeEnum,
    historical: z.boolean().openapi({
      description:
        'True when the owner switched this server to historical: Tracearr keeps its history and stops contacting it',
    }),
    active_streams: z
      .number()
      .int()
      .openapi({ description: 'Streams playing on this server right now', example: 2 }),
    version: z.string().nullable().openapi({
      description:
        'The version the media server last reported to Tracearr; null until it has been checked',
      example: '1.41.0',
    }),
  })
  .openapi('Server', {
    example: {
      server_id: SERVER_ID,
      server_name: 'Attic',
      status: 'up',
      reason: null,
      server_type: 'plex',
      historical: false,
      active_streams: 2,
      version: '1.41.0',
    },
  });

const ServersResponse = z
  .object({
    data: z.array(Server),
    tracearr_version: z
      .string()
      .openapi({ description: 'The Tracearr version answering', example: '2.7.0' }),
  })
  .openapi('ServersResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/servers',
  tags: ['Servers'],
  summary: 'Servers and their health',
  description:
    'Every configured media server in dashboard order, with the reachability Tracearr last ' +
    'recorded. The first four keys of a row, server_id, server_name, status and reason, are the ' +
    'server.health event payload: apply status and reason from the event to the row with the ' +
    'same server_id. A server.health ' +
    'with a server_id you do not hold, or one marking a server historical (it arrives as up), ' +
    'is a cue to fetch this list again. A row fetched from this list is newer than any earlier ' +
    'server.health event and wins over it. Fetch this list again after your own event stream ' +
    'reconnects.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Servers retrieved',
      content: { 'application/json': { schema: ServersResponse } },
    },
    ...AUTH_ERROR_RESPONSES,
  },
});

// ============================================================================
// GET /events (server-sent events)
// ============================================================================

const EVENT_TYPES = [
  'stream.started',
  'stream.updated',
  'stream.progress',
  'stream.stopped',
  'violation.created',
  'server.health',
] as const;

const EventsQuery = z.object({
  types: z
    .string()
    .optional()
    .openapi({
      description:
        'Comma-separated event types to receive; ready always arrives. Default: every type. Values: ' +
        EVENT_TYPES.join(', ') +
        '. An empty list or an unknown name returns 400. Leave it unset and new event types ' +
        'arrive as Tracearr adds them; a client must ignore any event type it does not recognize',
      example: 'stream.started,stream.stopped',
    }),
  server_id: z.uuid().optional().openapi({
    description:
      "Only events for this server. Leave it out to receive every server on one connection and filter on each event's server_id",
  }),
});

const EVENT_AT = {
  description: 'When Tracearr observed the event, ISO 8601 UTC',
  example: '2026-10-06T10:00:05.000Z',
};

// What formatActiveStream emits for a cached session: library_id and genres null.
const ACTIVE_STREAM_EXAMPLE = {
  id: STREAM_ID,
  server_id: SERVER_ID,
  server_name: 'Attic',
  server_type: 'plex',
  username: 'alice',
  user_thumb: 'https://plex.tv/users/8f3a1c/avatar',
  user_avatar_url: 'https://plex.tv/users/8f3a1c/avatar',
  media_title: 'Inception',
  media_type: 'movie',
  show_title: null,
  season_number: null,
  episode_number: null,
  year: 2010,
  artist_name: null,
  album_name: null,
  track_number: null,
  disc_number: null,
  thumb_path: '/library/metadata/27205/thumb/1759740000',
  poster_url:
    '/api/v1/images/proxy?server=5c1a4c1e-0b2d-4f6a-9d3e-2b7c8f9a1d20&url=%2Flibrary%2Fmetadata%2F27205%2Fthumb%2F1759740000&width=360&height=540&fallback=poster&v=54aaaba1',
  duration_ms: 8880000,
  state: 'playing',
  progress_ms: 1260000,
  started_at: '2026-10-06T09:39:00.000Z',
  is_transcode: false,
  video_decision: 'directplay',
  audio_decision: 'directplay',
  bitrate: 24500,
  source_video_codec: 'hevc',
  source_audio_codec: 'truehd',
  source_audio_channels: 8,
  source_video_width: 3840,
  source_video_height: 2160,
  source_video_details: {
    bitrate: 24000,
    framerate: '23.976',
    dynamicRange: 'HDR10',
    profile: 'main 10',
    colorDepth: 10,
  },
  source_audio_details: { channelLayout: '7.1', language: 'eng', sampleRate: 48000 },
  stream_video_codec: 'hevc',
  stream_audio_codec: 'truehd',
  stream_video_details: { width: 3840, height: 2160, framerate: '23.976', dynamicRange: 'HDR10' },
  stream_audio_details: { channels: 8, language: 'eng' },
  transcode_info: null,
  subtitle_info: null,
  resolution: '4K',
  source_video_codec_display: 'HEVC',
  source_audio_codec_display: 'TrueHD',
  audio_channels_display: '7.1',
  stream_video_codec_display: 'HEVC',
  stream_audio_codec_display: 'TrueHD',
  device: 'Apple TV',
  player: 'Living room',
  product: 'Plex for Apple TV',
  platform: 'tvOS',
  media_id: '9b2e7d41-3c5a-4f8e-b6d1-0a7c2e9f4b35',
  show_media_id: null,
  imdb_id: 'tt1375666',
  tmdb_id: 27205,
  tvdb_id: null,
  rating_key: '27205',
  parent_rating_key: null,
  grandparent_rating_key: null,
  library_id: null,
  genres: null,
};

const STREAM_PROGRESS_EXAMPLE = {
  id: STREAM_ID,
  server_id: SERVER_ID,
  state: 'playing',
  progress_ms: 1275000,
  bitrate: 24500,
};

const SERVER_HEALTH_EXAMPLE = {
  server_id: SERVER_ID,
  server_name: 'Attic',
  status: 'down',
  reason: 'unauthorized',
};

const StreamProgress = z
  .object({
    id: z.uuid().openapi({ description: 'Session id, the same id as the ActiveStream' }),
    server_id: z.uuid().openapi({ description: 'Server the stream plays on' }),
    state: ActiveStateEnum,
    progress_ms: z
      .number()
      .int()
      .openapi({ description: 'Playback position in milliseconds from the start of the media' }),
    bitrate: z.number().int().nullable().openapi({
      description: 'Current stream bitrate in kbps; null when the server reports none',
    }),
  })
  .openapi('StreamProgress', { example: STREAM_PROGRESS_EXAMPLE });

const StreamStopped = z
  .object({
    id: z.uuid().openapi({ description: 'Session id of the stream that stopped' }),
    server_id: z
      .uuid()
      .nullable()
      .openapi({ description: 'Server the stream played on; null when stream is null' }),
    stream: ActiveStream.nullable().openapi({
      description:
        'The last snapshot Tracearr held for this stream, from live events or from the active session cache. Null when the session was never in that cache, or when the server process holding the connection evicted it from its last-seen map, which keeps the 5,000 most recently started or updated streams',
    }),
  })
  .openapi('StreamStopped', {
    example: { id: STREAM_ID, server_id: SERVER_ID, stream: ACTIVE_STREAM_EXAMPLE },
  });

const ServerHealth = z
  .object({
    server_id: z.uuid().openapi({ description: 'Server whose reachability changed' }),
    server_name: z.string().openapi({ description: 'Server name as set in Tracearr' }),
    status: z.enum(['up', 'down']).openapi({
      description:
        'down when Tracearr can no longer reach the server, up when it can again. Apply it to the GET /servers row with this server_id',
    }),
    reason: z.enum(['unauthorized']).nullable().openapi({
      description:
        'Why the server is down when Tracearr knows: unauthorized means the stored credentials were rejected. Null for an up event or an unreachable server',
    }),
  })
  .openapi('ServerHealth', { example: SERVER_HEALTH_EXAMPLE });

function envelope<T extends (typeof EVENT_TYPES)[number] | 'ready', D extends z.ZodType>(
  type: T,
  data: D,
  dataDescription: string
) {
  return z.object({
    type: z
      .literal(type)
      .openapi({ description: 'Event type, the same value as the SSE event field' }),
    at: z.iso.datetime().openapi(EVENT_AT),
    data: data.openapi({ description: dataDescription }),
  });
}

const ReadyEvent = envelope('ready', z.object({}), 'Always empty').openapi('ReadyEvent', {
  description:
    'Sent after retry on every connect, and again whenever the server reconnects to its own event source. Fetch current state over REST when it arrives',
  example: { type: 'ready', at: '2026-10-06T10:00:00.000Z', data: {} },
});

const StreamStartedEvent = envelope(
  'stream.started',
  ActiveStream,
  'The new stream, in the GET /streams shape. library_id and genres are always null on events'
).openapi('StreamStartedEvent', {
  description: 'A stream began playing',
  example: { type: 'stream.started', at: '2026-10-06T09:39:02.000Z', data: ACTIVE_STREAM_EXAMPLE },
});

const StreamUpdatedEvent = envelope(
  'stream.updated',
  ActiveStream,
  'The whole stream again, in the GET /streams shape. library_id and genres are always null on events'
).openapi('StreamUpdatedEvent', {
  description:
    'The full stream again. Sent when the stream pauses, resumes, starts or stops buffering, or changes media, and once per poll tick for one of the streams that changed. The position in it can trail the latest stream.progress. Coalesced to one per stream every 2 s',
  example: {
    type: 'stream.updated',
    at: '2026-10-06T10:00:05.000Z',
    data: { ...ACTIVE_STREAM_EXAMPLE, state: 'paused' },
  },
});

const StreamProgressEvent = envelope(
  'stream.progress',
  StreamProgress,
  'Position, state and bitrate only; apply it to the ActiveStream held for data.id'
).openapi('StreamProgressEvent', {
  description:
    'A playback position update, once per poll tick per stream, coalesced to one per stream every 2 s',
  example: {
    type: 'stream.progress',
    at: '2026-10-06T10:00:20.000Z',
    data: STREAM_PROGRESS_EXAMPLE,
  },
});

const StreamStoppedEvent = envelope(
  'stream.stopped',
  StreamStopped,
  'The stopped stream id and the last snapshot held for it'
).openapi('StreamStoppedEvent', {
  description: 'A stream ended. Remove data.id from the list held since ready',
  example: {
    type: 'stream.stopped',
    at: '2026-10-06T12:07:00.000Z',
    data: { id: STREAM_ID, server_id: SERVER_ID, stream: ACTIVE_STREAM_EXAMPLE },
  },
});

const ViolationCreatedEvent = envelope(
  'violation.created',
  Violation,
  'The violation, the same object GET /violations lists. Prepend it to the list held since ready'
).openapi('ViolationCreatedEvent', {
  description: 'An automation recorded a violation',
  example: { type: 'violation.created', at: '2026-10-06T10:00:05.000Z', data: VIOLATION_EXAMPLE },
});

const ServerHealthEvent = envelope(
  'server.health',
  ServerHealth,
  'The server and its new status, the first four keys of its GET /servers row'
).openapi('ServerHealthEvent', {
  description:
    'A media server became unreachable or reachable again. Marking a server historical also sends up for it; fetch GET /servers to see the historical flag',
  example: { type: 'server.health', at: '2026-10-06T10:30:00.000Z', data: SERVER_HEALTH_EXAMPLE },
});

const PublicEvent = z
  .discriminatedUnion('type', [
    ReadyEvent,
    StreamStartedEvent,
    StreamUpdatedEvent,
    StreamProgressEvent,
    StreamStoppedEvent,
    ViolationCreatedEvent,
    ServerHealthEvent,
  ])
  .openapi('PublicEvent', {
    description:
      'The JSON in the data field of every frame. type matches the SSE event field, so a client that reads only data can still tell the events apart',
  });

const sseFrame = (type: string, body: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;

const EVENT_STREAM_EXAMPLE =
  'retry: 5000\n\n' +
  sseFrame('ready', { type: 'ready', at: '2026-10-06T10:00:00.000Z', data: {} }) +
  sseFrame('stream.started', {
    type: 'stream.started',
    at: '2026-10-06T10:00:02.000Z',
    data: ACTIVE_STREAM_EXAMPLE,
  }) +
  sseFrame('stream.progress', {
    type: 'stream.progress',
    at: '2026-10-06T10:00:20.000Z',
    data: STREAM_PROGRESS_EXAMPLE,
  }) +
  ': ping\n\n';

registry.registerPath({
  method: 'get',
  path: '/api/v2/public/events',
  tags: ['Live events'],
  summary: 'Live events (server-sent events)',
  description:
    'The app keeps one connection open and Tracearr pushes each event down it as it happens: a ' +
    'stream starting, pausing, progressing or stopping, a new violation, a server going down or ' +
    'coming back. The app does not poll. ' +
    'REST is used once per connection: when the `ready` event arrives, fetch the starting state that ' +
    'later events apply to, from `GET /streams` for streams, `GET /violations` for violations and ' +
    '`GET /servers` for server health, all under `/api/v2/public`. ' +
    'Each frame carries `event:` (the type) and `data:` (a JSON PublicEvent with ' +
    'the same `type`, an `at` timestamp and the payload in `data`). The first frame is `retry: 5000`, ' +
    'then `ready`. Nothing is replayed after a disconnect; a reconnect gets a fresh `ready`, and so ' +
    'does every open connection when the server reconnects to its own event source. Read the "Live ' +
    'events" section at the top of this document before integrating: shared-key limits, budget, ' +
    'coalescing, widgets and proxy settings.',
  security: [{ bearerAuth: [] }],
  request: { query: EventsQuery },
  responses: {
    200: {
      description:
        'Event connection opened. The body is an SSE stream that stays open until the client closes it, the key is regenerated, the server shuts down, or 30 minutes pass',
      content: { 'text/event-stream': { schema: PublicEvent, example: EVENT_STREAM_EXAMPLE } },
    },
    400: {
      description: 'types is empty or names an unknown event type, or server_id is not a uuid',
    },
    ...AUTH_ERROR_RESPONSES,
    503: {
      description:
        'Tracearr is starting up or cannot reach Redis. Sent before any retry frame, so EventSource-style clients stop here; wait a few seconds, then open a new connection',
    },
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
          '480p, sd). Null on show rows, which carry no file of their own',
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
  tags: ['Media'],
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
  tags: ['Media'],
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
  tags: ['Media'],
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
  tags: ['Media'],
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
  tags: ['Media'],
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
    identity_name: z
      .string()
      .nullable()
      .openapi({ description: 'Display name set in Tracearr, null when none is set' }),
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
  tags: ['Users'],
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
  tags: ['Users'],
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
  tags: ['Users'],
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
  tags: ['Users'],
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
  tags: ['Libraries'],
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
  tags: ['Libraries'],
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
  tags: ['Media'],
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
    'combination and cached for 60 seconds, and every page of a walk reads that same snapshot. ' +
    'Page until meta.nextCursor is null rather than until a short page: a title deleted mid-walk ' +
    'is skipped, so a page can hold fewer than pageSize rows and still have pages after it.',
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
    tags: [...V2_TAGS],
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

Generate your API key in **Settings > Data & API > API**.

## Pagination

The history, users, recently-added, watched-media and violations endpoints use cursor pagination via
\`cursor\` and \`pageSize\`. Most cap pageSize at 100 with a default of 25; watched-media
carries far smaller rows and allows up to 1000, defaulting to 100. Each paginated response
carries a \`meta.nextCursor\` to fetch the following page. Streams, servers and libraries return the
full set in one response.

## Filtering

History, streams, watchers, recently-added, watched-media and violations accept \`server_id\` to filter
by media server.

## Live events

\`GET /events\` keeps one connection open and Tracearr pushes each event down it as it happens:
a stream starting, pausing, progressing or stopping, a new violation, a server going down or
coming back. The app does not poll. The connection takes the same \`Authorization: Bearer\`
header as every other route. The browser's built-in \`EventSource\` cannot send request headers,
so use an SSE client that can, such as a fetch-based reader or the \`eventsource\` package for Node.

REST is used once per connection. Every connection starts with \`retry: 5000\` and then a \`ready\`
event; when \`ready\` arrives, fetch the starting state that later events apply to: \`GET /streams\`
for playing streams, \`GET /violations\` for violations and \`GET /servers\` for server health.
\`violation.created\` carries a \`GET /violations\` row, so prepend it. Acknowledging or dismissing a
violation sends no event, so refetch \`GET /violations\` when the list needs to show either.
\`server.health\` carries the
first four keys of a \`GET /servers\` row, so apply \`status\` and \`reason\` to the row with the same
\`server_id\`. A fresh \`GET /servers\` row wins over an earlier \`server.health\` event. Refetch
\`GET /servers\` after your own reconnect. Nothing is replayed. If the server loses its own connection to its event source and
gets it back, it sends \`ready\` again on every open connection. Treat that one exactly like the first.

Every frame has an \`event:\` line naming the type and a \`data:\` line holding one JSON object,
\`{"type", "at", "data"}\`, where \`type\` repeats the event name, \`at\` is when Tracearr observed it
and \`data\` is the payload. The types are \`ready\`, \`stream.started\`, \`stream.updated\`,
\`stream.progress\`, \`stream.stopped\`, \`violation.created\` and \`server.health\`; the \`PublicEvent\`
schema and the example on \`GET /events\` show each payload and a raw stream. \`stream.started\`
and \`stream.updated\` carry the whole stream in the \`GET /streams\` shape, except that \`library_id\`
and \`genres\` are always null on events. Apply \`stream.progress\` to the stream held under its
\`data.id\`, and drop that id on \`stream.stopped\`. Errors are JSON with \`error\` and \`message\`.

Ignore any event type you do not recognize. Tracearr adds event types without a new API version,
and a connection with no \`types\` parameter receives every type, new ones included. An app that
wants only the types it handles names them in \`types\`. Naming a type this Tracearr does not know
returns 400, so an app that also targets older Tracearr versions should name only types those
versions list.

A connection can also end before \`ready\`. That happens when the server cannot subscribe to its
event source, and the right response is an ordinary reconnect.

Clients that follow the EventSource reconnect rules wait the \`retry\` interval (5 s) after a
200 connection ends or drops, connect again and get a fresh \`ready\`. The server ends every
connection after 30 minutes, so expect that reconnect at least twice an hour. Those rules treat
any other status as fatal: on a 429 or 503 an EventSource-style client sets \`readyState\` to
CLOSED and stops for good. Handle both yourself. On 429, wait the seconds in \`Retry-After\`, then
open a new connection. A 503 means Tracearr is starting up or cannot reach Redis; wait a few
seconds and try again, and back off if it keeps happening. Regenerating the API key closes every
open connection for that key, and a reconnect with the old key gets 401.

One connection with no \`server_id\` carries every server. An app that shows a subset filters on
each event's \`server_id\` instead of opening one connection per server.

There is one API key per owner, and every app and device the owner connects shares it: phone and
tablet apps, a wall dashboard, Home Assistant. At most 20 connections can be open per key across
every Tracearr process that shares the same Redis, and the 21st connect gets 429 with
\`Retry-After: 30\`. One process also holds at most 100 connections across all keys and answers the
same way when full. So an app that leaks connections can lock every other app on the key out.
Connections held by a process that crashed stop counting within 75 seconds. Each connect also
counts as one request against the key's per-minute budget, which every v2 route shares (240 by
default, set in Settings > Data & API > API), and every reconnect costs the REST reads that
\`ready\` asks for.

Home-screen widgets cannot hold a connection open. iOS WidgetKit and Android periodic updates
wake a widget briefly and put it back to sleep, so widgets keep polling REST. Use the event
connection for live in-app screens and always-on dashboards.

\`stream.progress\` and \`stream.updated\` are coalesced per stream: a connection gets at most one
of each per stream every 2 s, carrying the latest values. The other event types go out as they
happen. A \`: ping\` comment line arrives every 25 s. A client that stops reading is dropped once
about 256 KB of unsent data builds up for it.

Behind a reverse proxy, turn off response buffering for this path (the response already sends
\`X-Accel-Buffering: no\` and \`Cache-Control: no-cache, no-transform\`) and leave compression off
for \`text/event-stream\`; Tracearr's own gzip (\`GZIP_ENABLED=true\`) never applies to it. Set
the proxy's idle or read timeout above 30 s, or it will cut the connection between pings.
      `.trim(),
      contact: {
        name: 'Tracearr',
        url: 'https://github.com/connorgallopo/Tracearr',
      },
    },
  });
}
