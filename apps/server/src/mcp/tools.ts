/**
 * MCP tool registry.
 *
 * Each tool is a thin adapter over an existing Tracearr public API endpoint.
 * Tool handlers forward to the public routes via `app.inject()`, which reuses
 * the exact query logic, validation, and authorization already in place. This
 * keeps the MCP surface in lock-step with the OpenAPI-documented public API and
 * avoids duplicating any database logic.
 *
 * Phase 1 exposes read-only tools only. Write tools (terminate stream, adjust
 * trust, rule management) are intentionally deferred to a later phase behind an
 * explicit write-permission gate.
 */

import { z, type ZodRawShape } from 'zod';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** HTTP method of the backing public endpoint (Phase 1 is GET-only). */
  method: 'GET';
  /** Path relative to the public API prefix, e.g. `/stats/today`. */
  path: string;
  /** Zod raw shape describing the tool's input arguments. */
  inputSchema: ZodRawShape;
}

const serverId = z
  .uuid()
  .optional()
  .describe('Optional server UUID to scope results to a single media server.');

const timezone = z
  .string()
  .optional()
  .describe('IANA timezone identifier (e.g. America/New_York). Defaults to UTC.');

const page = z.number().int().min(1).optional().describe('Page number (1-based). Defaults to 1.');

const pageSize = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Items per page (max 100). Defaults to 25.');

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_server_health',
    title: 'Get server health',
    description:
      'Return overall system health and per-media-server connectivity, including active stream counts. Use to check whether Plex/Jellyfin/Emby servers are online.',
    method: 'GET',
    path: '/health',
    inputSchema: {},
  },
  {
    name: 'get_overview_stats',
    title: 'Get overview stats',
    description:
      'Return high-level totals: active streams, total users, total plays (last 30 days) and recent violations (last 7 days). Optionally scope to one server.',
    method: 'GET',
    path: '/stats',
    inputSchema: { serverId },
  },
  {
    name: 'get_dashboard_stats',
    title: "Get today's dashboard stats",
    description:
      "Return today's dashboard statistics with timezone-aware day boundaries. Use for 'how is today looking' style questions.",
    method: 'GET',
    path: '/stats/today',
    inputSchema: { timezone, serverId },
  },
  {
    name: 'list_active_streams',
    title: 'List active streams',
    description:
      'List currently active playback sessions with media, user, device, geolocation and transcode details, plus a summary breakdown. Set summary=true for counts only (lighter payload).',
    method: 'GET',
    path: '/streams',
    inputSchema: {
      serverId,
      summary: z
        .boolean()
        .optional()
        .describe('If true, return only summary counts and omit the per-stream array.'),
    },
  },
  {
    name: 'list_users',
    title: 'List users',
    description:
      'List users (one row per user-server pair) with trust score, total violations, last activity and play count. Paginated; optionally scoped to one server.',
    method: 'GET',
    path: '/users',
    inputSchema: { page, pageSize, serverId },
  },
  {
    name: 'query_violations',
    title: 'Query violations',
    description:
      'List rule violations with rule, user and server context. Filter by server, severity (low/warning/high) and acknowledged state. Paginated.',
    method: 'GET',
    path: '/violations',
    inputSchema: {
      page,
      pageSize,
      serverId,
      severity: z
        .enum(['low', 'warning', 'high'])
        .optional()
        .describe('Filter to a single severity level.'),
      acknowledged: z
        .boolean()
        .optional()
        .describe('Filter by acknowledged state (true = acknowledged, false = open).'),
    },
  },
  {
    name: 'query_session_history',
    title: 'Query session history',
    description:
      'Query historical playback sessions (grouped into unique plays) with media, device and transcode details. Filter by server, state, media type and date range (timezone-aware). Paginated.',
    method: 'GET',
    path: '/history',
    inputSchema: {
      page,
      pageSize,
      serverId,
      state: z
        .enum(['playing', 'paused', 'stopped'])
        .optional()
        .describe('Filter to a single playback state.'),
      mediaType: z
        .enum(['movie', 'episode', 'track', 'live', 'photo', 'unknown'])
        .optional()
        .describe('Filter to a single media type.'),
      startDate: z
        .string()
        .optional()
        .describe('Inclusive start date (YYYY-MM-DD), interpreted in the given timezone.'),
      endDate: z
        .string()
        .optional()
        .describe('Inclusive end date (YYYY-MM-DD), interpreted in the given timezone.'),
      timezone,
    },
  },
  {
    name: 'get_activity_trends',
    title: 'Get activity trends',
    description:
      'Return consolidated activity analytics: plays over time, concurrent streams, day-of-week and hour-of-day distributions, platform usage and quality (transcode) breakdown, for a week/month/year window.',
    method: 'GET',
    path: '/activity',
    inputSchema: {
      period: z
        .enum(['week', 'month', 'year'])
        .optional()
        .describe('Time window for the trends. Defaults to month.'),
      serverId,
      timezone,
    },
  },
];
