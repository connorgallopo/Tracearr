import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
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
} from '@tracearr/shared';
import {
  getRequestsAnalytics,
  type RequestsAnalyticsData,
} from '../services/requests/analytics.js';
import { anyRequestServiceEnabled } from '../services/requests/store.js';
import { resolveServerIds } from '../utils/serverFiltering.js';

type SortValue = string | number | null;

const UNPLAYED_SORT_VALUES: Record<RequestUnplayedSort, (row: RequestOutcomeRow) => SortValue> = {
  fileSizeBytes: (row) => row.fileSizeBytes,
  waitMs: (row) => row.waitMs,
  requestedAt: (row) => row.requestedAt,
  title: (row) => row.title?.toLowerCase() ?? null,
};

const REQUESTER_SORT_VALUES: Record<RequesterSort, (row: RequesterFollowThrough) => SortValue> = {
  watchedByOthers: (row) => row.watchedByOthers,
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
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return order === 'asc' ? delta : -delta;
}

function page<T>(
  rows: T[],
  valueOf: (row: T) => SortValue,
  query: { page: number; pageSize: number; sortOrder: 'asc' | 'desc' }
): { data: T[]; total: number; page: number; pageSize: number } {
  const sorted = [...rows].sort((a, b) => compare(valueOf(a), valueOf(b), query.sortOrder));
  const start = (query.page - 1) * query.pageSize;
  return {
    data: sorted.slice(start, start + query.pageSize),
    total: rows.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export const requestRoutes: FastifyPluginAsync = async (app) => {
  async function loadAnalytics(
    authUser: AuthUser,
    serverIds: string[] | undefined
  ): Promise<RequestsAnalyticsData> {
    const resolvedIds = resolveServerIds(authUser, undefined, serverIds);
    const scopeKey = resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all';
    const cacheKey = `${REDIS_KEYS.REQUESTS_ANALYTICS}:${scopeKey}`;

    const cached = await app.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as RequestsAnalyticsData;
      } catch {
        // Fall through to compute.
      }
    }

    const data = await getRequestsAnalytics(resolvedIds);
    await app.redis.setex(cacheKey, CACHE_TTL.REQUESTS_ANALYTICS, JSON.stringify(data));
    return data;
  }

  app.get('/status', { preHandler: [app.authenticate] }, async (): Promise<RequestsStatus> => {
    return { configured: await anyRequestServiceEnabled() };
  });

  app.get<{ Querystring: Record<string, unknown> }>(
    '/analytics',
    { preHandler: [app.authenticate] },
    async (request, reply): Promise<RequestsAnalyticsResponse | FastifyReply> => {
      const query = requestsAnalyticsQuerySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const data = await loadAnalytics(request.user, query.data.serverIds);
      return {
        funnel: data.funnel,
        unplayed: { count: data.unplayed.length, bytes: data.unplayedBytes },
        requesterCount: data.requesters.length,
      };
    }
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    '/unplayed',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = requestsUnplayedQuerySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const data = await loadAnalytics(request.user, query.data.serverIds);
      return page(data.unplayed, UNPLAYED_SORT_VALUES[query.data.sortBy], query.data);
    }
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    '/requesters',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = requestersQuerySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const data = await loadAnalytics(request.user, query.data.serverIds);
      return page(data.requesters, REQUESTER_SORT_VALUES[query.data.sortBy], query.data);
    }
  );
};
