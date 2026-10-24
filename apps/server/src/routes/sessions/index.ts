/**
 * Session routes - Query historical and active sessions
 *
 * Activity history is grouped by reference_id to show unique "plays" rather than
 * individual session records. Multiple pause/resume cycles for the same content
 * are aggregated into a single row with combined duration.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  sessionQuerySchema,
  historyQuerySchema,
  historyAggregatesQuerySchema,
  filterOptionsQuerySchema,
  sessionIdParamSchema,
  sessionDetailQuerySchema,
  serverIdFilterSchema,
  terminateSessionBodySchema,
  CACHE_TTL,
  REDIS_KEYS,
  type ActiveSession,
  type HistorySessionResponse,
  type HistoryAggregates,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import {
  baseSessionConditions,
  historyMediaTypeDefault,
  readSessionRow,
  readSessionRows,
  sessionRowsWhere,
} from '../../db/sessions/index.js';
import { hasServerAccess, resolveServerIds } from '../../utils/serverFiltering.js';
import { terminateSession } from '../../services/termination.js';
import { getCacheService } from '../../services/cache.js';
import {
  assertInScope,
  memberCacheSegment,
  seesServerActivity,
  viewScope,
} from '../../lib/scope.js';
import { fetchHistoryAggregates } from './aggregates.js';
import { fetchSessionDetailRow, mapSessionDetail } from './detail.js';
import { emptyFilterOptions, queryFilterOptions } from './filterOptions.js';
import {
  buildCacheFingerprint,
  buildHistoryFilterConditions,
  countPlays,
  fetchHistoryPage,
  fetchSessionPage,
  parseHistoryCursor,
} from './history.js';
import { mapHistoryRow } from './historyRow.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const readSessions = { preHandler: [app.requirePermission('sessions', 'read')] };
  const readHistory = { preHandler: [app.requirePermission('history', 'read')] };
  const terminateSessions = { preHandler: [app.requirePermission('sessions', 'terminate')] };
  /**
   * GET /sessions - Query historical sessions with pagination and filters
   *
   * Sessions are grouped by reference_id to show unique "plays". Multiple
   * pause/resume cycles for the same content appear as one row with:
   * - Aggregated duration (total watch time)
   * - First session's start time
   * - Last session's stop time
   * - Segment count (how many pause/resume cycles)
   */
  app.get('/', readSessions, async (request, reply) => {
    const query = sessionQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, serverUserId, serverId, state, mediaType, startDate, endDate } =
      query.data;

    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    const conditions = baseSessionConditions({
      authUser,
      serverId,
      scope: request.scope,
      startDate,
      endDate,
    });
    if (!conditions) {
      return { data: [], page, pageSize, total: 0, totalPages: 0 };
    }
    if (serverUserId) conditions.push(sql`s.server_user_id = ${serverUserId}`);
    if (state) conditions.push(sql`s.state = ${state}`);
    conditions.push(mediaType ? sql`s.media_type = ${mediaType}` : historyMediaTypeDefault());

    const sessionData = (
      await fetchSessionPage(conditions, { startDate, endDate, pageSize, offset })
    ).map(mapHistoryRow);

    const total = await countPlays(conditions);

    return {
      data: sessionData,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  /**
   * GET /sessions/history - Query history with cursor-based pagination and advanced filters
   *
   * Supports comprehensive filtering for the History page:
   * - Title search (ILIKE on mediaTitle and grandparentTitle)
   * - Device/client filters (platform, product, device, playerName)
   * - Network/location filters (ipAddress, geoCountry, geoCity, geoRegion)
   * - Stream quality (isTranscode)
   * - Status filters (watched, excludeShortSessions)
   * - Cursor-based pagination for efficient infinite scroll
   */
  app.get('/history', readHistory, async (request, reply) => {
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { cursor, pageSize, orderBy, orderDir } = query.data;

    const authUser = request.user;

    // Build WHERE conditions using shared helper
    const filterResult = buildHistoryFilterConditions(query.data, authUser, request.scope);
    if (!filterResult) {
      // No server access - return empty result
      return { data: [], hasMore: false } satisfies HistorySessionResponse;
    }
    const { conditions } = filterResult;

    const pageCursor = cursor ? parseHistoryCursor(cursor, orderBy) : null;
    if (pageCursor === undefined) return reply.badRequest('Invalid cursor');

    const rows = await fetchHistoryPage({
      conditions,
      orderBy,
      orderDir,
      pageSize,
      cursor: pageCursor,
      startDate: query.data.startDate,
      endDate: query.data.endDate,
    });

    const firstRow = rows[0];
    const hasMore = firstRow ? Number(firstRow.page_candidate_count) > pageSize : false;

    if (rows.length === 0) {
      return { data: [], hasMore: false } satisfies HistorySessionResponse;
    }

    const sessionData = rows.map(mapHistoryRow);

    // Generate next cursor
    const lastSession = sessionData[sessionData.length - 1];
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      hasMore && lastSession?.startedAt
        ? [
            `${new Date(lastSession.startedAt).getTime()}`,
            lastSession.id,
            ...(orderBy === 'startedAt'
              ? []
              : [Buffer.from(JSON.stringify(lastRow?.sort_key ?? null)).toString('hex')]),
          ].join('_')
        : undefined;

    const response: HistorySessionResponse = {
      // Cast through unknown since we're serializing dates to ISO strings for the wire format
      data: sessionData as unknown as HistorySessionResponse['data'],
      nextCursor,
      hasMore,
    };

    return response;
  });

  /**
   * GET /sessions/history/aggregates - Get aggregate stats for filtered history
   *
   * Returns only aggregate statistics (total plays, watch time, unique users/content)
   * without the actual session data. This endpoint is called separately from /history
   * so that sorting changes don't trigger a refetch of these stats (since aggregates
   * are not affected by sort order).
   */
  app.get('/history/aggregates', readHistory, async (request, reply) => {
    const query = historyAggregatesQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const authUser = request.user;
    const scope = await viewScope(request);

    // Build WHERE clause using shared helper (also enforces server access via resolveServerIds)
    const filterResult = buildHistoryFilterConditions(query.data, authUser, scope);
    if (!filterResult) {
      // No server access - return empty result
      const emptyAggregates: HistoryAggregates = {
        totalWatchTimeMs: 0,
        listenTimeMs: 0,
        playCount: 0,
        uniqueUsers: 0,
        uniqueContent: 0,
      };
      return emptyAggregates;
    }
    const { whereClause } = filterResult;

    const resolvedIds = resolveServerIds(authUser, query.data.serverId, query.data.serverIds, {
      strict: false,
    });
    const cacheKey = `${REDIS_KEYS.HISTORY_AGGREGATES(
      buildCacheFingerprint({ ...query.data, scope, resolvedIds })
    )}${memberCacheSegment(scope)}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as HistoryAggregates;

    const aggregates = await fetchHistoryAggregates(whereClause, resolvedIds);

    await app.redis.setex(cacheKey, CACHE_TTL.HISTORY_AGGREGATES, JSON.stringify(aggregates));
    return aggregates;
  });

  /**
   * GET /sessions/filter-options - Get available filter values for dropdowns
   *
   * Returns distinct values for platforms, products, devices, countries, cities,
   * users, and optionally servers to populate filter dropdowns.
   *
   * Query params:
   * - serverId: Filter by specific server
   * - startDate: Filter by start date (ISO 8601)
   * - endDate: Filter by end date, exclusive (ISO 8601)
   * - includeAllCountries: When true, returns all countries with hasSessions indicator
   *                        (for rules builder). When false/omitted, returns only
   *                        countries with sessions (for history page).
   */
  app.get('/filter-options', readHistory, async (request, reply) => {
    const query = filterOptionsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const {
      serverId,
      serverIds: rawServerIds,
      startDate,
      endDate,
      includeAllCountries,
    } = query.data;

    const authUser = request.user;

    // Resolve effective server IDs (handles owner bypass + access intersection)
    const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds, { strict: false });
    if (resolvedIds?.length === 0) {
      return emptyFilterOptions(includeAllCountries);
    }

    // Check cache
    const cacheService = getCacheService();
    const filterScopeHash = buildCacheFingerprint({
      userId: authUser.userId,
      resolvedIds: resolvedIds ? [...resolvedIds].sort() : null,
      startDate,
      endDate,
      includeAllCountries,
    });
    if (cacheService) {
      const cached = await cacheService.getFilterOptions(authUser.userId, filterScopeHash);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const response = await queryFilterOptions({
      resolvedIds,
      scope: request.scope,
      accessibleServerIds: authUser.serverIds,
      startDate,
      endDate,
      includeAllCountries,
    });

    if (cacheService) {
      void cacheService.setFilterOptions(
        authUser.userId,
        filterScopeHash,
        JSON.stringify(response)
      );
    }

    return response;
  });

  /**
   * GET /sessions/active - Get currently active streams from cache
   */
  app.get('/active', readSessions, async (request, _reply) => {
    const authUser = request.user;

    // Parse optional server filter (supports both legacy serverId and serverIds[])
    const query = serverIdFilterSchema.safeParse(request.query);
    const { serverId: legacyServerId, serverIds: rawServerIds } = query.success
      ? query.data
      : { serverId: undefined, serverIds: undefined };
    const resolvedIds = resolveServerIds(authUser, legacyServerId, rawServerIds, { strict: false });

    // Get active sessions from atomic SET-based cache
    const cacheService = getCacheService();
    let activeSessions: ActiveSession[] = [];

    if (cacheService) {
      activeSessions = await cacheService.getAllActiveSessions();
    }

    // Filter by resolved server IDs
    if (resolvedIds !== undefined) {
      const idSet = new Set(resolvedIds);
      activeSessions = activeSessions.filter((s) => idSet.has(s.serverId));
    }
    // else: owner with no filter, keep all

    const scope = await viewScope(request);
    if (scope === 'all') return { data: activeSessions };
    const own = new Set(scope.serverUserIds);
    const mine = activeSessions.filter((s) => own.has(s.serverUserId));
    // The count is a member's view of others; an owner asking for self wants only their streams.
    if (request.scope === 'all' || !(await seesServerActivity(request.scope))) {
      return { data: mine };
    }
    return { data: mine, othersActive: activeSessions.length - mine.length };
  });

  /**
   * GET /sessions/:id - Get detailed info for a specific session
   */
  app.get('/:id', readSessions, async (request, reply) => {
    const params = sessionIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid session ID');
    }
    const detailQuery = sessionDetailQuerySchema.safeParse(request.query);
    if (!detailQuery.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Try cache first for active sessions
    const cached = await app.redis.get(REDIS_KEYS.SESSION_BY_ID(id));
    if (cached) {
      try {
        const activeSession = JSON.parse(cached) as ActiveSession;
        // Verify access (owners can see all servers)
        if (
          hasServerAccess(authUser, activeSession.serverId) &&
          assertInScope(request.scope, activeSession.serverUserId)
        ) {
          // Return ActiveSession directly - both types now use nested user/server
          return activeSession;
        }
      } catch {
        // Fall through to DB
      }
    }

    const row = await fetchSessionDetailRow(id, detailQuery.data.startedAt);
    // Out of scope answers exactly like a missing id, so a member cannot probe for others' rows.
    if (!row || !assertInScope(request.scope, row.serverUserId)) {
      return reply.notFound('Session not found');
    }

    // Verify access (owners can see all servers)
    if (!hasServerAccess(authUser, row.serverId)) {
      return reply.forbidden('You do not have access to this session');
    }

    return mapSessionDetail(row);
  });

  /**
   * POST /sessions/:id/terminate - Terminate a playback session
   *
   * Requires admin access. Sends a stop command to the media server
   * and logs the termination for auditing.
   */
  app.post('/:id/terminate', terminateSessions, async (request, reply) => {
    const params = sessionIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid session ID');
    }

    const body = terminateSessionBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const { reason } = body.data;
    const authUser = request.user;

    // Verify the session exists and user has access to its server; a live one is in the cache

    const cached = await getCacheService()?.getSessionById(id);

    const sessionData = await readSessionRow(id, cached?.startedAt, (where) =>
      db

        .select({
          id: sessions.id,

          serverId: sessions.serverId,

          serverUserId: sessions.serverUserId,

          state: sessions.state,

          startedAt: sessions.startedAt,
        })

        .from(sessions)

        .where(where)

        .limit(1)

        .then((rows) => rows[0])
    );
    if (!sessionData) {
      return reply.notFound('Session not found');
    }

    if (!hasServerAccess(authUser, sessionData.serverId)) {
      return reply.forbidden('You do not have access to this server');
    }

    // Check if session is already stopped
    if (sessionData.state === 'stopped') {
      return reply.conflict('Session has already ended');
    }

    // Attempt termination
    const result = await terminateSession({
      sessionId: id,
      trigger: 'manual',
      triggeredByUserId: authUser.userId,
      reason,
      sessionStartedAt: sessionData.startedAt,
    });

    if (result.outcome === 'server_historical') {
      return reply.conflict('Resume this server to end its streams');
    }

    if (!result.success) {
      app.log.error(
        { sessionId: id, error: result.error, terminationLogId: result.terminationLogId },
        'Failed to terminate session'
      );
      return reply.code(500).send({
        success: false,
        error: result.error,
        terminationLogId: result.terminationLogId,
      });
    }

    return {
      success: true,
      terminationLogId: result.terminationLogId,
      message: 'Stream termination command sent successfully',
    };
  });

  /**
   * DELETE /sessions/bulk - Bulk delete historical sessions
   * Owner-only. Accepts array of session IDs.
   */
  app.delete('/bulk', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const authUser = request.user;

    const body = request.body as { ids: string[] };

    if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.badRequest('ids array is required');
    }

    const sessionDetails = await readSessionRows(body.ids, (where) =>
      db
        .select({ id: sessions.id, serverId: sessions.serverId, startedAt: sessions.startedAt })
        .from(sessions)
        .where(where)
    );

    const accessibleRows = sessionDetails.filter((s) => hasServerAccess(authUser, s.serverId));

    if (accessibleRows.length === 0) {
      return { success: true, deleted: 0 };
    }

    await db.delete(sessions).where(sessionRowsWhere(accessibleRows));

    return { success: true, deleted: accessibleRows.length };
  });
};
