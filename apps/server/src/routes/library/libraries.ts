/**
 * Library options endpoint
 *
 * GET /libraries - Names/media type per library, scoped to the caller's
 * accessible servers. Powers the catalog browse Library filter select.
 * Cached per sorted serverIds.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  serverIdsQuerySchema,
  REDIS_KEYS,
  CACHE_TTL,
  type LibraryOption,
  type LibrariesResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { compareNames } from '../../utils/collation.js';
import { libraryCacheSegment, libraryFragment, type Scope } from '../../lib/scope.js';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

const librariesQuerySchema = z.object({
  serverIds: serverIdsQuerySchema,
});

interface RawLibraryRow {
  server_id: string;
  server_name: string;
  server_display_order: number;
  library_id: string;
  name: string;
  media_type: string;
}

async function fetchLibraries(
  serverIds: string[] | undefined,
  scope: Scope
): Promise<LibraryOption[]> {
  const serverFragment = libraryFragment(serverIds, scope, 'l');
  const result = await db.execute(sql`
    SELECT l.server_id, s.name AS server_name, s.display_order AS server_display_order,
           l.library_id, l.name, l.media_type
    FROM libraries l
    JOIN servers s ON s.id = l.server_id
    WHERE 1=1 ${serverFragment}
    ORDER BY l.library_id
  `);
  const rows = (result.rows as unknown as RawLibraryRow[]).sort(
    (a, b) =>
      a.server_display_order - b.server_display_order ||
      compareNames(a.server_name, b.server_name) ||
      compareNames(a.name, b.name) ||
      a.library_id.localeCompare(b.library_id)
  );
  return rows.map((row) => ({
    serverId: row.server_id,
    serverName: row.server_name,
    libraryId: row.library_id,
    name: row.name,
    mediaType: row.media_type,
  }));
}

export const libraryLibrariesRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /libraries - Per-server library names/media types for the catalog
   * Library filter, scoped to the caller's accessible servers.
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    '/libraries',
    { preHandler: [app.requirePermission('media', 'read')] },
    async (request, reply) => {
      const query = librariesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const authUser = request.user;

      // Guard: server scope, fail-closed.
      const resolvedIds = resolveServerIds(authUser, undefined, query.data.serverIds);

      const serverCacheKey =
        (resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all') +
        libraryCacheSegment(request.scope);
      const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_LIBRARIES, serverCacheKey);

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibrariesResponse;
        } catch {
          // Fall through to compute.
        }
      }

      const data = await fetchLibraries(resolvedIds, request.scope);
      const response: LibrariesResponse = { data };
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_LIBRARIES, JSON.stringify(response));

      return response;
    }
  );
};
