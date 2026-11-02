/**
 * Duplicate File Existence Route
 *
 * GET /duplicates/files - does the server still have the files behind these
 * duplicate items? Plex keeps listing a file after it is deleted until the
 * library trash is emptied, so a duplicate can outlive its file and no amount
 * of syncing clears it. Only Plex can answer; other servers drop the item
 * instead, and the response says it was not checked rather than guessing.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryDuplicateFilesQuerySchema,
  type LibraryDuplicateFilesQueryInput,
  type DuplicateFileStatus,
  type DuplicateFilesResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { createMediaServerClient } from '../../services/mediaServer/index.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';
import { serverCacheSegment } from '../../lib/scope.js';

interface ItemRow {
  id: string;
  rating_key: string;
  server_id: string;
  server_type: 'plex' | 'jellyfin' | 'emby';
  server_url: string;
  server_token: string;
  server_historical_at: string | null;
}

export const libraryDuplicateFilesRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: LibraryDuplicateFilesQueryInput }>(
    '/duplicates/files',
    { preHandler: [app.requirePermission('insights', 'read')] },
    async (request, reply) => {
      const query = libraryDuplicateFilesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { itemIds } = query.data;
      const resolvedIds = resolveServerIds(request.user, undefined, undefined);

      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_DUPLICATE_FILES,
        serverCacheSegment(resolvedIds),
        itemIds.toSorted().join(',')
      );
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as DuplicateFilesResponse;
        } catch {
          // Fall through to compute
        }
      }

      // The server filter is the access check: an id outside the caller's
      // scope returns no row, so it is never probed.
      const idsArray = `{${itemIds.join(',')}}`;
      const result = await db.execute(sql`
        SELECT li.id, li.rating_key, li.server_id,
               s.type AS server_type, s.url AS server_url, s.token AS server_token, s.historical_at AS server_historical_at
        FROM library_items li
        JOIN servers s ON s.id = li.server_id
        WHERE li.id = ANY(${idsArray}::uuid[])
          AND li.removed_at IS NULL
          ${buildMultiServerFragment(resolvedIds, 'li.server_id')}
      `);
      const rows = result.rows as unknown as ItemRow[];

      const byServer = new Map<string, ItemRow[]>();
      for (const row of rows) {
        const list = byServer.get(row.server_id) ?? [];
        list.push(row);
        byServer.set(row.server_id, list);
      }

      const files: DuplicateFileStatus[] = [];
      let checked = false;

      for (const [serverId, serverRows] of byServer) {
        const first = serverRows[0];
        if (!first) continue;
        // A historical server is never probed; its files stay unchecked.
        if (first.server_historical_at) continue;

        const client = createMediaServerClient({
          type: first.server_type,
          url: first.server_url,
          token: first.server_token,
          id: serverId,
          name: serverId,
        });
        if (!client.checkFilesExist) continue;

        try {
          const existence = await client.checkFilesExist(serverRows.map((r) => r.rating_key));
          checked = true;
          for (const row of serverRows) {
            for (const [serverVersionKey, exists] of existence.get(row.rating_key) ?? []) {
              files.push({ itemId: row.id, serverVersionKey, exists });
            }
          }
        } catch (err) {
          app.log.warn({ err, serverId }, 'Duplicate file check failed');
        }
      }

      const response: DuplicateFilesResponse = { checked, files };
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_DUPLICATE_FILES, JSON.stringify(response));
      return response;
    }
  );
};
