import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  myRequestsQuerySchema,
  requestersQuerySchema,
  requestsAnalyticsQuerySchema,
  requestsUnplayedQuerySchema,
  CACHE_TTL,
  REDIS_KEYS,
  type AuthUser,
  type RequesterFollowThrough,
  type RequesterSort,
  type RequestOutcomeRow,
  type RequestsAnalyticsResponse,
  type RequestsStatus,
  type RequestUnplayedSort,
  type UserRequestsResponse,
} from '@tracearr/shared';
import {
  getRequestsAnalytics,
  type RequestsAnalyticsData,
} from '../services/requests/analytics.js';
import { listUserRequests } from '../services/requests/reads.js';
import { anyRequestServiceLinked } from '../services/requests/store.js';
import { compareNames } from '../utils/collation.js';
import { resolveServerIds } from '../utils/serverFiltering.js';
import {
  memberCacheSegment,
  ownScope,
  seesServerActivity,
  type Scope,
  serverCacheSegment,
} from '../lib/scope.js';

type SortValue = string | number | null;

const UNPLAYED_SORT_VALUES: Record<RequestUnplayedSort, (row: RequestOutcomeRow) => SortValue> = {
  fileSizeBytes: (row) => row.fileSizeBytes,
  waitMs: (row) => row.waitMs,
  requestedAt: (row) => row.requestedAt,
  title: (row) => row.title?.toLowerCase() ?? null,
};

const REQUESTER_SORT_VALUES: Record<RequesterSort, (row: RequesterFollowThrough) => SortValue> = {
  watchedByOthers: (row) => row.watchedByOthers ?? null,
  requested: (row) => row.requested,
  landed: (row) => row.landed,
  watched: (row) => row.watched,
  medianWaitMs: (row) => row.medianWaitMs,
  name: (row) => (row.requester.identityName ?? row.requester.username ?? '').toLowerCase(),
};

/** Missing values sort last in both directions; there is no useful ordering among them. */
function compare(a: SortValue, b: SortValue, order: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const delta =
    typeof a === 'number' && typeof b === 'number' ? a - b : compareNames(String(a), String(b));
  return order === 'asc' ? delta : -delta;
}

function page<T>(
  rows: T[],
  valueOf: (row: T) => SortValue,
  query: { page: number; pageSize: number; sortOrder: 'asc' | 'desc' }
): { data: T[]; total: number; page: number; pageSize: number } {
  const sorted = rows.toSorted((a, b) => compare(valueOf(a), valueOf(b), query.sortOrder));
  const start = (query.page - 1) * query.pageSize;
  return {
    data: sorted.slice(start, start + query.pageSize),
    total: rows.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export const requestRoutes: FastifyPluginAsync = async (app) => {
  const readRequests = { preHandler: [app.requirePermission('requests', 'read')] };
  async function loadAnalytics(
    authUser: AuthUser,
    scope: Scope,
    serverIds: string[] | undefined
  ): Promise<RequestsAnalyticsData> {
    const resolvedIds = resolveServerIds(authUser, undefined, serverIds);
    const serverKey = serverCacheSegment(resolvedIds);
    const showOthers = await seesServerActivity(scope);
    const activityKey = scope !== 'all' && showOthers ? ':activity' : '';
    const cacheKey = `${REDIS_KEYS.REQUESTS_ANALYTICS}:${serverKey}${memberCacheSegment(scope)}${activityKey}`;

    const cached = await app.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as RequestsAnalyticsData;
      } catch {
        // Fall through to compute.
      }
    }

    const data = await getRequestsAnalytics(resolvedIds, scope, showOthers);
    await app.redis.setex(cacheKey, CACHE_TTL.REQUESTS_ANALYTICS, JSON.stringify(data));
    return data;
  }

  app.get('/status', readRequests, async (): Promise<RequestsStatus> => {
    return { configured: await anyRequestServiceLinked() };
  });

  // /users/:id/requests needs a serverUserId the web does not have; this is the viewer's own.
  app.get<{ Querystring: Record<string, unknown> }>(
    '/mine',
    readRequests,
    async (request, reply): Promise<UserRequestsResponse | FastifyReply> => {
      const query = myRequestsQuerySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const mine = await ownScope(request.user.userId, request.scope);
      return listUserRequests({
        serverUserIds: mine.serverUserIds,
        showOthers: false,
        serverIds: resolveServerIds(request.user, undefined, undefined),
        page: query.data.page,
        pageSize: query.data.pageSize,
      });
    }
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    '/analytics',
    { preHandler: [app.requirePermission('requests', 'read')] },
    async (request, reply): Promise<RequestsAnalyticsResponse | FastifyReply> => {
      const query = requestsAnalyticsQuerySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const data = await loadAnalytics(request.user, request.scope, query.data.serverIds);
      return {
        funnel: data.funnel,
        unplayed: { count: data.unplayed.length, bytes: data.unplayedBytes },
        requesterCount: data.requesters.length,
      };
    }
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    '/unplayed',
    { preHandler: [app.requirePermission('requests', 'read')] },
    async (request, reply) => {
      const query = requestsUnplayedQuerySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const data = await loadAnalytics(request.user, request.scope, query.data.serverIds);
      return page(data.unplayed, UNPLAYED_SORT_VALUES[query.data.sortBy], query.data);
    }
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    '/requesters',
    { preHandler: [app.requirePermission('requests', 'read')] },
    async (request, reply) => {
      const query = requestersQuerySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const data = await loadAnalytics(request.user, request.scope, query.data.serverIds);
      return page(data.requesters, REQUESTER_SORT_VALUES[query.data.sortBy], query.data);
    }
  );
};
