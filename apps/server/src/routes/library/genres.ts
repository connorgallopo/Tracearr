/**
 * Genres endpoints
 *
 * GET /genres - Per-genre rows for one media type over a range, with the hour strip and totals
 * GET /genres/:genre - One genre's sheet: KPIs, weekly series this and prior, hour strip,
 * top viewers, top titles and never played titles
 *
 * Item counts follow the libraries the caller can open; a member's plays are their own.
 * Cached per (servers, type, timezone, period, aligned bounds, member, libraries).
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CACHE_TTL,
  REDIS_KEYS,
  genreDetailQuerySchema,
  genresQuerySchema,
  type GenreDetailResponse,
  type GenresQueryInput,
  type GenresResponse,
} from '@tracearr/shared';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { libraryCacheSegment, memberCacheSegment, serverCacheSegment } from '../../lib/scope.js';
import {
  queryGenreDetail,
  queryGenreRows,
  resolveGenreWindow,
  type GenreScope,
  type GenreWindow,
} from '../../services/library/genreStats.js';
import { buildLibraryCacheKey } from './utils.js';

const genreParamsSchema = z.object({ genre: z.string().min(1).max(100) });

function genreScope(request: FastifyRequest, query: GenresQueryInput): GenreScope {
  return {
    type: query.type,
    resolvedServerIds: resolveServerIds(request.user, query.serverId, query.serverIds),
    scope: request.scope,
    timezone: query.timezone ?? 'UTC',
  };
}

export const libraryGenresRoute: FastifyPluginAsync = async (app) => {
  const readMedia = { preHandler: [app.requirePermission('media', 'read')] };

  async function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = await app.redis.get(key);
    if (hit) {
      try {
        return JSON.parse(hit) as T;
      } catch {
        // Fall through to compute
      }
    }
    const value = await compute();
    if (value !== null) {
      await app.redis.setex(key, CACHE_TTL.LIBRARY_GENRES, JSON.stringify(value));
    }
    return value;
  }

  function cacheKey(s: GenreScope, w: GenreWindow, suffix = ''): string {
    const servers = serverCacheSegment(s.resolvedServerIds);
    const bounds = `${w.period}:${w.range.start?.toISOString() ?? 'all'}:${w.range.end.toISOString()}`;
    return `${buildLibraryCacheKey(REDIS_KEYS.LIBRARY_GENRES, servers, s.type, s.timezone)}:${bounds}${suffix}${memberCacheSegment(s.scope)}${libraryCacheSegment(s.scope)}`;
  }

  app.get<{ Querystring: Record<string, unknown> }>(
    '/genres',
    readMedia,
    async (request, reply) => {
      const query = genresQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const scope = genreScope(request, query.data);
      const window = resolveGenreWindow(query.data);

      return cached<GenresResponse>(cacheKey(scope, window), () => queryGenreRows(scope, window));
    }
  );

  app.get<{ Params: Record<string, unknown>; Querystring: Record<string, unknown> }>(
    '/genres/:genre',
    readMedia,
    async (request, reply) => {
      const params = genreParamsSchema.safeParse(request.params);
      const query = genreDetailQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { genre } = params.data;
      const scope = genreScope(request, query.data);
      const window = resolveGenreWindow(query.data);

      const detail = await cached<GenreDetailResponse | null>(
        cacheKey(scope, window, `:genre:${genre}`),
        () => queryGenreDetail(scope, window, genre)
      );
      if (!detail) {
        return reply.notFound('Genre not found');
      }
      return detail;
    }
  );
};
