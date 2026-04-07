/**
 * OpenAPI Schema Definitions for Public API
 *
 * Uses @asteasolutions/zod-to-openapi to generate OpenAPI 3.0 documentation.
 * Single source of truth for both validation and documentation.
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
// Shared Enums (single source of truth)
// ============================================================================

const ServerTypeEnum = z.enum(['plex', 'jellyfin', 'emby']);
const MediaTypeEnum = z.enum(['movie', 'episode', 'track', 'live', 'photo', 'unknown']);
const PlaybackStateEnum = z.enum(['playing', 'paused', 'stopped']);
const SeverityEnum = z.enum(['low', 'warning', 'high']);
const UserRoleEnum = z.enum(['owner', 'admin', 'viewer', 'member', 'disabled', 'pending']);
const TranscodeDecisionEnum = z.enum(['directplay', 'copy', 'transcode']);

// ============================================================================
// Shared Primitives
// ============================================================================

const ServerIdParam = z.uuid().openapi({
  description: 'Media server UUID',
  example: '550e8400-e29b-41d4-a716-446655440000',
});

const PaginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1).openapi({ example: 1 }),
  pageSize: z.coerce.number().int().positive().max(100).default(25).openapi({ example: 25 }),
});

const PaginationMeta = z
  .object({
    total: z.number().int().openapi({ example: 42 }),
    page: z.number().int().openapi({ example: 1 }),
    pageSize: z.number().int().openapi({ example: 25 }),
  })
  .openapi('PaginationMeta');

// ============================================================================
// Shared Component Schemas
// ============================================================================

const ServerInfo = z.object({
  serverId: z.uuid(),
  serverName: z.string().openapi({ example: 'Main Plex Server' }),
});

const UserInfo = z.object({
  id: z.uuid(),
  username: z.string().openapi({ example: 'john_doe' }),
  thumbUrl: z.string().nullable().openapi({ description: 'Avatar path from media server' }),
  avatarUrl: z.string().nullable().openapi({ description: 'Proxied avatar URL' }),
});

const MediaInfo = z.object({
  mediaTitle: z.string().openapi({ example: 'Inception' }),
  mediaType: MediaTypeEnum,
  ratingKey: z
    .string()
    .nullable()
    .openapi({ description: 'Server-specific media identifier', example: '12345' }),
  showTitle: z
    .string()
    .nullable()
    .openapi({ description: 'Show name (episodes only)', example: 'Breaking Bad' }),
  seasonNumber: z.number().int().nullable().openapi({ example: 5 }),
  episodeNumber: z.number().int().nullable().openapi({ example: 16 }),
  year: z.number().int().nullable().openapi({ example: 2010 }),
  imdbId: z
    .string()
    .nullable()
    .openapi({ description: 'IMDb identifier when available', example: 'tt1375666' }),
  tmdbId: z
    .number()
    .int()
    .nullable()
    .openapi({ description: 'TMDb identifier when available', example: 27205 }),
  tvdbId: z
    .number()
    .int()
    .nullable()
    .openapi({ description: 'TVDb identifier when available', example: 80379 }),
  artistName: z
    .string()
    .nullable()
    .openapi({ description: 'Artist name (music tracks only)', example: 'Pink Floyd' }),
  albumName: z.string().nullable().openapi({
    description: 'Album name (music tracks only)',
    example: 'The Dark Side of the Moon',
  }),
  trackNumber: z
    .number()
    .int()
    .nullable()
    .openapi({ description: 'Track number (music tracks only)', example: 3 }),
  discNumber: z
    .number()
    .int()
    .nullable()
    .openapi({ description: 'Disc number (music tracks only)', example: 1 }),
  thumbPath: z.string().nullable().openapi({ description: 'Poster path' }),
  posterUrl: z.string().nullable().openapi({ description: 'Proxied poster URL' }),
});

const DeviceInfo = z.object({
  device: z.string().nullable().openapi({ example: 'Apple TV' }),
  player: z.string().nullable().openapi({ example: 'Plex for Apple TV' }),
  product: z.string().nullable().openapi({ example: 'Plex for Apple TV' }),
  platform: z.string().nullable().openapi({ example: 'tvOS' }),
});

// ============================================================================
// Stream Quality Schemas (shared between /streams and /history)
// ============================================================================

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
    speed: z
      .number()
      .optional()
      .openapi({ description: 'Transcode speed multiplier', example: 2.5 }),
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

const StreamDetails = z.object({
  isTranscode: z.boolean().nullable(),
  videoDecision: TranscodeDecisionEnum.nullable(),
  audioDecision: TranscodeDecisionEnum.nullable(),
  bitrate: z.number().int().nullable().openapi({ description: 'Bitrate in kbps', example: 20000 }),
  sourceVideoCodec: z.string().nullable().openapi({ example: 'hevc' }),
  sourceAudioCodec: z.string().nullable().openapi({ example: 'truehd' }),
  sourceAudioChannels: z.number().int().nullable().openapi({ example: 8 }),
  sourceVideoWidth: z.number().int().nullable().openapi({ example: 3840 }),
  sourceVideoHeight: z.number().int().nullable().openapi({ example: 2160 }),
  sourceVideoDetails: SourceVideoDetails,
  sourceAudioDetails: SourceAudioDetails,
  streamVideoCodec: z.string().nullable().openapi({ example: 'h264' }),
  streamAudioCodec: z.string().nullable().openapi({ example: 'aac' }),
  streamVideoDetails: StreamVideoDetails,
  streamAudioDetails: StreamAudioDetails,
  transcodeInfo: TranscodeInfo,
  subtitleInfo: SubtitleInfo,
});

const DisplayValues = z.object({
  resolution: z
    .string()
    .nullable()
    .openapi({ description: '4K, 1080p, 720p, etc.', example: '4K' }),
  sourceVideoCodecDisplay: z.string().nullable().openapi({ example: 'HEVC' }),
  sourceAudioCodecDisplay: z.string().nullable().openapi({ example: 'TrueHD' }),
  audioChannelsDisplay: z.string().nullable().openapi({ example: '7.1' }),
  streamVideoCodecDisplay: z.string().nullable().openapi({ example: 'H.264' }),
  streamAudioCodecDisplay: z.string().nullable().openapi({ example: 'AAC' }),
});

// ============================================================================
// GET /health
// ============================================================================

const ServerStatus = z
  .object({
    id: z.uuid(),
    name: z.string().openapi({ example: 'Main Plex Server' }),
    type: ServerTypeEnum,
    online: z.boolean(),
    activeStreams: z.number().int().openapi({ example: 3 }),
  })
  .openapi('ServerStatus');

const HealthResponse = z
  .object({
    status: z.literal('ok'),
    version: z.string().openapi({ description: 'Tracearr server version', example: '1.4.22' }),
    timestamp: z.iso.datetime().openapi({ example: '2024-01-15T12:00:00.000Z' }),
    servers: z.array(ServerStatus),
  })
  .openapi('HealthResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v1/public/health',
  tags: ['Public API'],
  summary: 'Check server connectivity',
  description: 'Returns connection status for all configured media servers.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Health check successful',
      content: { 'application/json': { schema: HealthResponse } },
    },
    401: { description: 'Invalid or missing API key' },
  },
});

// ============================================================================
// GET /stats
// ============================================================================

const StatsQuery = z.object({
  serverId: ServerIdParam.optional().openapi({ description: 'Filter by server' }),
});

const StatsResponse = z
  .object({
    activeStreams: z.number().int().openapi({ example: 5 }),
    totalUsers: z.number().int().openapi({ example: 24 }),
    totalSessions: z
      .number()
      .int()
      .openapi({ description: 'Sessions in last 30 days', example: 1847 }),
    recentViolations: z
      .number()
      .int()
      .openapi({ description: 'Violations in last 7 days', example: 3 }),
    timestamp: z.iso.datetime(),
  })
  .openapi('StatsResponse');

const StatsTodayQuery = z.object({
  serverId: ServerIdParam.optional().openapi({ description: 'Filter by server' }),
  timezone: z.string().default('UTC').openapi({
    description: 'IANA timezone for "today" calculation',
    example: 'America/New_York',
  }),
});

const StatsTodayResponse = z
  .object({
    activeStreams: z.number().int().openapi({ example: 5 }),
    todayPlays: z
      .number()
      .int()
      .openapi({ description: 'Validated plays (>= 2 min)', example: 47 }),
    watchTimeHours: z.number().openapi({ description: 'Hours watched today', example: 12.5 }),
    alertsLast24h: z.number().int().openapi({ example: 3 }),
    activeUsersToday: z.number().int().openapi({ example: 8 }),
    timestamp: z.iso.datetime(),
  })
  .openapi('StatsTodayResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v1/public/stats',
  tags: ['Public API'],
  summary: 'Dashboard statistics',
  description: 'Aggregate counts for dashboard display. Optionally filter by server.',
  security: [{ bearerAuth: [] }],
  request: { query: StatsQuery },
  responses: {
    200: {
      description: 'Statistics retrieved',
      content: { 'application/json': { schema: StatsResponse } },
    },
    401: { description: 'Invalid or missing API key' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/public/stats/today',
  tags: ['Public API'],
  summary: "Today's dashboard statistics",
  description:
    'Dashboard metrics for "today" in the specified timezone. Includes active streams, validated plays (>= 2 min), watch time, alerts, and active users.',
  security: [{ bearerAuth: [] }],
  request: { query: StatsTodayQuery },
  responses: {
    200: {
      description: 'Statistics retrieved',
      content: { 'application/json': { schema: StatsTodayResponse } },
    },
    400: { description: 'Invalid timezone or serverId' },
    401: { description: 'Invalid or missing API key' },
  },
});

// ============================================================================
// GET /activity
// ============================================================================

const ActivityPeriodEnum = z.enum(['week', 'month', 'year']);

const ActivityQuery = z.object({
  period: ActivityPeriodEnum.default('month').openapi({
    description: 'Time range for activity data',
    example: 'month',
  }),
  serverId: ServerIdParam.optional().openapi({ description: 'Filter by server' }),
  timezone: z.string().default('UTC').openapi({
    description: 'IANA timezone for date bucketing',
    example: 'America/New_York',
  }),
});

const PlayDataPoint = z.object({
  date: z.string().openapi({ description: 'Bucket start time', example: '2026-02-08 00:00:00' }),
  count: z.number().int().openapi({ example: 45 }),
});

const ConcurrentDataPoint = z.object({
  date: z.string().openapi({ description: 'Bucket start time', example: '2026-02-08 00:00:00' }),
  total: z.number().int().openapi({ example: 7 }),
  direct: z.number().int().openapi({ description: 'Direct play streams', example: 4 }),
  directStream: z.number().int().openapi({ description: 'Direct stream (remux)', example: 1 }),
  transcode: z.number().int().openapi({ example: 2 }),
});

const DayOfWeekDataPoint = z.object({
  day: z.number().int().openapi({ description: '0 = Sunday, 6 = Saturday', example: 5 }),
  name: z.string().openapi({ example: 'Fri' }),
  count: z.number().int().openapi({ example: 120 }),
});

const HourOfDayDataPoint = z.object({
  hour: z.number().int().openapi({ description: '0-23', example: 20 }),
  count: z.number().int().openapi({ example: 35 }),
});

const PlatformDataPoint = z.object({
  platform: z.string().nullable().openapi({ example: 'Chrome' }),
  count: z.number().int().openapi({ example: 89 }),
});

const QualityBreakdown = z
  .object({
    directPlay: z.number().int().openapi({ example: 234 }),
    directStream: z.number().int().openapi({ example: 56 }),
    transcode: z.number().int().openapi({ example: 120 }),
    total: z.number().int().openapi({ example: 410 }),
    directPlayPercent: z.number().int().openapi({ description: 'Rounded percentage', example: 57 }),
    directStreamPercent: z.number().int().openapi({ example: 14 }),
    transcodePercent: z.number().int().openapi({ example: 29 }),
  })
  .openapi('QualityBreakdown');

const ActivityResponse = z
  .object({
    period: ActivityPeriodEnum,
    range: z.object({
      start: z.iso.datetime().openapi({ example: '2026-02-08T05:00:00.000Z' }),
      end: z.iso.datetime().openapi({ example: '2026-03-10T14:30:00.000Z' }),
    }),
    plays: z.array(PlayDataPoint).openapi({
      description:
        'Play counts bucketed over time. Engagement-based: only sessions >= 2 min. ' +
        'Bucket size is 6 hours for week, 1 day for month/year.',
    }),
    concurrent: z.array(ConcurrentDataPoint).openapi({
      description: 'Peak concurrent streams per time bucket, broken down by playback type.',
    }),
    byDayOfWeek: z.array(DayOfWeekDataPoint).openapi({
      description: 'Play distribution across days of the week. Always 7 entries.',
    }),
    byHourOfDay: z.array(HourOfDayDataPoint).openapi({
      description: 'Play distribution across hours of the day. Always 24 entries.',
    }),
    platforms: z.array(PlatformDataPoint).openapi({
      description: 'Session counts by client platform, sorted by count descending.',
    }),
    quality: QualityBreakdown,
  })
  .openapi('ActivityResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v1/public/activity',
  tags: ['Public API'],
  summary: 'Playback activity trends',
  description:
    'Consolidated activity data across six dimensions: plays over time, concurrent streams, ' +
    'day-of-week and hour-of-day distributions, platform usage, and playback quality. ' +
    'Time-series data is bucketed by 6 hours (week) or 1 day (month/year). ' +
    'Play counts use engagement-based filtering (sessions >= 2 minutes).',
  security: [{ bearerAuth: [] }],
  request: { query: ActivityQuery },
  responses: {
    200: {
      description: 'Activity data retrieved',
      content: { 'application/json': { schema: ActivityResponse } },
    },
    400: { description: 'Invalid query parameters' },
    401: { description: 'Invalid or missing API key' },
    500: { description: 'Internal server error' },
  },
});

// ============================================================================
// GET /streams
// ============================================================================

const StreamsQuery = z.object({
  serverId: ServerIdParam.optional().openapi({ description: 'Filter by server' }),
  summary: z.coerce.boolean().optional().openapi({
    description: 'Return only summary (omit data array)',
    example: false,
  }),
});

const Stream = z
  .object({
    id: z.uuid(),
    ...ServerInfo.shape,
    // User
    username: z.string().openapi({ example: 'John Doe' }),
    userThumb: z.string().nullable(),
    userAvatarUrl: z.string().nullable(),
    // Media
    ...MediaInfo.shape,
    durationMs: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Total media length', example: 8880000 }),
    // Playback
    state: PlaybackStateEnum,
    progressMs: z.number().int().openapi({ example: 3600000 }),
    startedAt: z.iso.datetime(),
    // Stream quality
    ...StreamDetails.shape,
    ...DisplayValues.shape,
    // Device
    ...DeviceInfo.shape,
  })
  .openapi('Stream');

const ServerStreamSummary = z
  .object({
    ...ServerInfo.shape,
    total: z.number().int().openapi({ example: 3 }),
    transcodes: z.number().int().openapi({ example: 1 }),
    directStreams: z.number().int().openapi({ example: 1 }),
    directPlays: z.number().int().openapi({ example: 1 }),
    totalBitrate: z.string().openapi({ example: '22.5 Mbps' }),
  })
  .openapi('ServerStreamSummary');

const StreamsSummary = z
  .object({
    total: z.number().int().openapi({ example: 5 }),
    transcodes: z.number().int().openapi({ example: 2 }),
    directStreams: z.number().int().openapi({ example: 1 }),
    directPlays: z.number().int().openapi({ example: 2 }),
    totalBitrate: z.string().openapi({ example: '45.2 Mbps' }),
    byServer: z.array(ServerStreamSummary),
  })
  .openapi('StreamsSummary');

const StreamsResponse = z
  .object({
    data: z.array(Stream),
    summary: StreamsSummary,
  })
  .openapi('StreamsResponse');

const StreamsSummaryOnlyResponse = z
  .object({
    summary: StreamsSummary,
  })
  .openapi('StreamsSummaryOnlyResponse');

const TerminateStreamBody = z
  .object({
    reason: z.string().optional().openapi({
      description: 'Message to display to user before termination',
    }),
  })
  .openapi('TerminateStreamBody');

const TerminateStreamResponse = z
  .object({
    success: z.literal(true),
    terminationLogId: z.uuid(),
    message: z.string().openapi({ example: 'Stream termination command sent successfully' }),
  })
  .openapi('TerminateStreamResponse');

const TerminateStreamErrorResponse = z
  .object({
    success: z.literal(false),
    error: z.string(),
    terminationLogId: z.uuid(),
  })
  .openapi('TerminateStreamErrorResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v1/public/streams',
  tags: ['Public API'],
  summary: 'Active playback sessions',
  description:
    'Real-time active streams with codec and quality details. ' +
    'Use summary=true for lightweight dashboard polling (omits data array).',
  security: [{ bearerAuth: [] }],
  request: { query: StreamsQuery },
  responses: {
    200: {
      description: 'Active streams retrieved',
      content: {
        'application/json': {
          schema: z.union([StreamsResponse, StreamsSummaryOnlyResponse]),
        },
      },
    },
    401: { description: 'Invalid or missing API key' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/public/streams/{id}/terminate',
  tags: ['Public API'],
  summary: 'Terminate active stream',
  description:
    'Stop an active playback session. Optionally display a message to the user (supported on all platforms).',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.uuid().openapi({ description: 'Session ID from /streams' }) }),
    body: {
      content: { 'application/json': { schema: TerminateStreamBody } },
    },
  },
  responses: {
    200: {
      description: 'Termination successful',
      content: { 'application/json': { schema: TerminateStreamResponse } },
    },
    400: { description: 'Invalid session ID or request body' },
    401: { description: 'Invalid or missing API key' },
    404: { description: 'Session not found' },
    409: { description: 'Session already ended' },
    500: {
      description: 'Termination failed',
      content: { 'application/json': { schema: TerminateStreamErrorResponse } },
    },
  },
});

// ============================================================================
// GET /users
// ============================================================================

const UsersQuery = PaginationQuery.extend({
  serverId: ServerIdParam.optional().openapi({ description: 'Filter by server' }),
});

const User = z
  .object({
    id: z.uuid(),
    username: z.string().openapi({ example: 'john_doe' }),
    displayName: z.string().openapi({ example: 'John Doe' }),
    thumbUrl: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    role: UserRoleEnum,
    trustScore: z.number().int().openapi({ description: '0-100', example: 95 }),
    totalViolations: z.number().int().openapi({ example: 2 }),
    ...ServerInfo.shape,
    lastActivityAt: z.iso.datetime().nullable(),
    sessionCount: z.number().int().openapi({ example: 147 }),
    createdAt: z.iso.datetime(),
  })
  .openapi('User');

const UsersResponse = z
  .object({
    data: z.array(User),
    meta: PaginationMeta,
  })
  .openapi('UsersResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v1/public/users',
  tags: ['Public API'],
  summary: 'User list with activity metrics',
  description:
    'Paginated users with session counts and trust scores. Users with accounts on multiple servers appear once per server.',
  security: [{ bearerAuth: [] }],
  request: { query: UsersQuery },
  responses: {
    200: {
      description: 'Users retrieved',
      content: { 'application/json': { schema: UsersResponse } },
    },
    401: { description: 'Invalid or missing API key' },
  },
});

// ============================================================================
// GET /violations
// ============================================================================

const ViolationsQuery = PaginationQuery.extend({
  serverId: ServerIdParam.optional().openapi({ description: 'Filter by server' }),
  severity: SeverityEnum.optional(),
  acknowledged: z.coerce.boolean().optional(),
});

const Violation = z
  .object({
    id: z.uuid(),
    ...ServerInfo.shape,
    severity: SeverityEnum,
    acknowledged: z.boolean(),
    data: z
      .record(z.string(), z.unknown())
      .openapi({ description: 'Rule-specific violation data' }),
    createdAt: z.iso.datetime(),
    rule: z.object({
      id: z.uuid(),
      type: z.string().openapi({ example: 'concurrent_streams' }),
      name: z.string().openapi({ example: 'Max 2 concurrent streams' }),
    }),
    user: UserInfo,
  })
  .openapi('Violation');

const ViolationsResponse = z
  .object({
    data: z.array(Violation),
    meta: PaginationMeta,
  })
  .openapi('ViolationsResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v1/public/violations',
  tags: ['Public API'],
  summary: 'Rule violations',
  description:
    'Paginated violations in descending order. Filter by server, severity, or acknowledged status.',
  security: [{ bearerAuth: [] }],
  request: { query: ViolationsQuery },
  responses: {
    200: {
      description: 'Violations retrieved',
      content: { 'application/json': { schema: ViolationsResponse } },
    },
    401: { description: 'Invalid or missing API key' },
  },
});

// ============================================================================
// GET /history
// ============================================================================

const HistoryQuery = PaginationQuery.extend({
  serverId: ServerIdParam.optional().openapi({ description: 'Filter by server' }),
  state: PlaybackStateEnum.optional(),
  mediaType: MediaTypeEnum.optional(),
  startDate: z.coerce.date().optional().openapi({
    description: 'Sessions on or after this date (start of day in timezone)',
  }),
  endDate: z.coerce.date().optional().openapi({
    description: 'Sessions on or before this date (end of day in timezone)',
  }),
  timezone: z.string().default('UTC').openapi({
    description: 'IANA timezone for date interpretation',
    example: 'America/New_York',
  }),
});

const SessionHistory = z
  .object({
    id: z.uuid(),
    ...ServerInfo.shape,
    state: PlaybackStateEnum,
    ...MediaInfo.shape,
    durationMs: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Total watch time across segments' }),
    progressMs: z.number().int().nullable(),
    totalDurationMs: z.number().int().nullable().openapi({ description: 'Media length' }),
    startedAt: z.iso.datetime(),
    stoppedAt: z.iso.datetime().nullable(),
    watched: z.boolean().openapi({ description: 'True if watched 85%+' }),
    segmentCount: z
      .number()
      .int()
      .openapi({ description: 'Pause/resume segment count', example: 1 }),
    ...DeviceInfo.shape,
    ...StreamDetails.shape,
    ...DisplayValues.shape,
    user: UserInfo,
  })
  .openapi('SessionHistory');

const HistoryResponse = z
  .object({
    data: z.array(SessionHistory),
    meta: PaginationMeta,
  })
  .openapi('HistoryResponse');

registry.registerPath({
  method: 'get',
  path: '/api/v1/public/history',
  tags: ['Public API'],
  summary: 'Session history',
  description:
    'Paginated session history grouped by unique plays. ' +
    'Multiple pause/resume cycles are aggregated into a single entry with combined duration and segment count.',
  security: [{ bearerAuth: [] }],
  request: { query: HistoryQuery },
  responses: {
    200: {
      description: 'History retrieved',
      content: { 'application/json': { schema: HistoryResponse } },
    },
    401: { description: 'Invalid or missing API key' },
  },
});

// ============================================================================
// Document Generator
// ============================================================================

export function generateOpenAPIDocument(): unknown {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Tracearr Public API',
      version: '1.0.0',
      description: `
External API for third-party integrations.

## Authentication

All endpoints require Bearer token authentication:

\`\`\`
Authorization: Bearer trr_pub_<your_token>
\`\`\`

Generate your API key in **Settings > General**.

## Pagination

Paginated endpoints support \`page\` (1-indexed) and \`pageSize\` (max 100, default 25).

## Filtering

Most endpoints support \`serverId\` to filter by media server.
      `.trim(),
      contact: {
        name: 'Tracearr',
        url: 'https://github.com/connorgallopo/Tracearr',
      },
    },
  });
}
