/**
 * Library Duplicates Route
 *
 * GET /duplicates - Cross-server duplicate detection with multi-ID matching hierarchy
 *
 * Matching hierarchy (confidence scores):
 * 1. IMDB ID match: 100%
 * 2. TMDB ID match: 95% (items without IMDB)
 * 3. TVDB ID match: 90% (items without IMDB/TMDB)
 * 4. Fuzzy title match: 60-100% (items without any external IDs)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryDuplicatesQuerySchema,
  type LibraryDuplicatesQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Match type for duplicate groups */
type MatchType = 'imdb' | 'tmdb' | 'tvdb' | 'fuzzy';

/** Individual item in a duplicate group */
interface DuplicateItem {
  id: string;
  serverId: string;
  serverName: string;
  title: string;
  year: number | null;
  mediaType: string;
  fileSize: number | null;
  resolution: string | null;
}

/** Group of duplicate items across servers */
interface DuplicateGroup {
  matchKey: string;
  matchType: MatchType;
  confidence: number;
  serverCount: number;
  items: DuplicateItem[];
  totalStorageBytes: number;
  potentialSavingsBytes: number;
}

/** Summary statistics for duplicate detection */
interface DuplicatesSummary {
  totalGroups: number;
  totalDuplicateItems: number;
  totalPotentialSavingsBytes: number;
  byMatchType: { imdb: number; tmdb: number; tvdb: number; fuzzy: number };
}

/** Full response for duplicates endpoint */
interface DuplicatesResponse {
  duplicates: DuplicateGroup[];
  summary: DuplicatesSummary;
  pagination: { page: number; pageSize: number; total: number };
}

/** Raw match row from database */
interface RawMatchRow {
  match_key: string;
  match_type: MatchType;
  confidence: number;
  server_ids: string[];
  item_ids: string[];
  server_count: number;
}

/** Raw fuzzy match row from database */
interface RawFuzzyRow {
  item_a_id: string;
  item_b_id: string;
  server_a_id: string;
  server_b_id: string;
  title_a: string;
  title_b: string;
  confidence: number;
}

/** Raw item details row */
interface ItemDetailsRow {
  id: string;
  server_id: string;
  server_name: string;
  title: string;
  year: number | null;
  media_type: string;
  file_size: string | null;
  video_resolution: string | null;
}

/**
 * Build SQL filter for accessible servers (handles non-owner role restrictions).
 * Returns both the SQL fragment and a flag indicating if filtering is needed.
 */
function buildServerAccessFilter(authUser: { role: string; serverIds: string[] }): {
  sql: ReturnType<typeof sql>;
  isRestricted: boolean;
} {
  if (authUser.role !== 'owner') {
    if (authUser.serverIds.length === 0) {
      return { sql: sql`AND false`, isRestricted: true };
    } else if (authUser.serverIds.length === 1) {
      return { sql: sql`AND server_id = ${authUser.serverIds[0]}`, isRestricted: true };
    } else {
      const serverIdList = authUser.serverIds.map((id: string) => sql`${id}`);
      return {
        sql: sql`AND server_id IN (${sql.join(serverIdList, sql`, `)})`,
        isRestricted: true,
      };
    }
  }
  return { sql: sql``, isRestricted: false };
}

export const libraryDuplicatesRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /duplicates - Cross-server duplicate detection
   *
   * Returns groups of duplicate content detected across servers using
   * multi-ID matching hierarchy: IMDB (100%) -> TMDB (95%) -> TVDB (90%) -> fuzzy.
   */
  app.get<{ Querystring: LibraryDuplicatesQueryInput }>(
    '/duplicates',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryDuplicatesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, mediaType, minConfidence, includeFuzzy, page, pageSize } = query.data;
      const authUser = request.user;

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key with all varying params
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_DUPLICATES,
        serverId,
        `${mediaType ?? 'all'}-${minConfidence}-${includeFuzzy}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as DuplicatesResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build server access filter for non-owner roles
      const serverAccessFilter = buildServerAccessFilter(authUser);

      // Optional media type filter
      const mediaTypeFilter = mediaType ? sql`AND media_type = ${mediaType}` : sql``;

      // Optional server involvement filter (show duplicates involving this server)
      // This is applied after grouping to find groups where at least one item is on the server
      const serverInvolvementFilter = serverId
        ? sql`HAVING ${serverId} = ANY(array_agg(DISTINCT server_id))`
        : sql`HAVING COUNT(DISTINCT server_id) > 1`;

      // Query for ID-based matches using CTEs with cascading exclusion
      const idMatchesResult = await db.execute(sql`
        WITH imdb_matches AS (
          SELECT
            imdb_id AS match_key,
            'imdb'::text AS match_type,
            100 AS confidence,
            array_agg(DISTINCT server_id) AS server_ids,
            array_agg(id ORDER BY server_id) AS item_ids,
            COUNT(DISTINCT server_id) AS server_count
          FROM library_items
          WHERE imdb_id IS NOT NULL
            ${serverAccessFilter.sql}
            ${mediaTypeFilter}
          GROUP BY imdb_id
          ${serverInvolvementFilter}
        ),
        tmdb_matches AS (
          SELECT
            tmdb_id::text AS match_key,
            'tmdb'::text AS match_type,
            95 AS confidence,
            array_agg(DISTINCT server_id) AS server_ids,
            array_agg(id ORDER BY server_id) AS item_ids,
            COUNT(DISTINCT server_id) AS server_count
          FROM library_items
          WHERE tmdb_id IS NOT NULL
            AND imdb_id IS NULL  -- Only items not already matched by IMDB
            ${serverAccessFilter.sql}
            ${mediaTypeFilter}
          GROUP BY tmdb_id
          ${serverInvolvementFilter}
        ),
        tvdb_matches AS (
          SELECT
            tvdb_id::text AS match_key,
            'tvdb'::text AS match_type,
            90 AS confidence,
            array_agg(DISTINCT server_id) AS server_ids,
            array_agg(id ORDER BY server_id) AS item_ids,
            COUNT(DISTINCT server_id) AS server_count
          FROM library_items
          WHERE tvdb_id IS NOT NULL
            AND imdb_id IS NULL
            AND tmdb_id IS NULL
            ${serverAccessFilter.sql}
            ${mediaTypeFilter}
          GROUP BY tvdb_id
          ${serverInvolvementFilter}
        ),
        all_matches AS (
          SELECT * FROM imdb_matches
          UNION ALL
          SELECT * FROM tmdb_matches
          UNION ALL
          SELECT * FROM tvdb_matches
        )
        SELECT * FROM all_matches
        WHERE confidence >= ${minConfidence}
        ORDER BY confidence DESC, match_type
      `);

      const idMatches = idMatchesResult.rows as unknown as RawMatchRow[];

      // Fuzzy matching query (only if includeFuzzy=true)
      let fuzzyMatches: RawFuzzyRow[] = [];
      if (includeFuzzy && minConfidence <= 70) {
        // Build server filter for fuzzy query (need to apply to both a and b tables)
        const fuzzyServerFilterA =
          serverAccessFilter.isRestricted && authUser.serverIds.length > 0
            ? sql`AND a.server_id IN (${sql.join(
                authUser.serverIds.map((id: string) => sql`${id}::uuid`),
                sql`, `
              )})`
            : sql``;
        const fuzzyServerFilterB =
          serverAccessFilter.isRestricted && authUser.serverIds.length > 0
            ? sql`AND b.server_id IN (${sql.join(
                authUser.serverIds.map((id: string) => sql`${id}::uuid`),
                sql`, `
              )})`
            : sql``;

        // Fuzzy match for items without external IDs
        const fuzzyResult = await db.execute(sql`
          SELECT
            a.id AS item_a_id,
            b.id AS item_b_id,
            a.server_id AS server_a_id,
            b.server_id AS server_b_id,
            a.title AS title_a,
            b.title AS title_b,
            ROUND(similarity(a.title, b.title) * 100)::int AS confidence
          FROM library_items a
          JOIN library_items b ON a.id < b.id  -- Avoid duplicate pairs
          WHERE a.server_id != b.server_id  -- Different servers only
            AND a.media_type = b.media_type  -- Same media type
            AND a.year = b.year  -- Same year (reduces false positives)
            AND similarity(a.title, b.title) >= 0.6  -- 60% threshold
            AND a.imdb_id IS NULL AND a.tmdb_id IS NULL AND a.tvdb_id IS NULL
            AND b.imdb_id IS NULL AND b.tmdb_id IS NULL AND b.tvdb_id IS NULL
            ${fuzzyServerFilterA}
            ${fuzzyServerFilterB}
            ${mediaType ? sql`AND a.media_type = ${mediaType}` : sql``}
          ORDER BY confidence DESC
          LIMIT 100
        `);
        fuzzyMatches = fuzzyResult.rows as unknown as RawFuzzyRow[];
      }

      // Collect all unique item IDs
      const allItemIds = new Set<string>();
      for (const match of idMatches) {
        for (const id of match.item_ids) {
          allItemIds.add(id);
        }
      }
      for (const fuzzy of fuzzyMatches) {
        allItemIds.add(fuzzy.item_a_id);
        allItemIds.add(fuzzy.item_b_id);
      }

      // Fetch item details if we have any items
      const itemDetailsMap = new Map<string, ItemDetailsRow>();
      if (allItemIds.size > 0) {
        const itemIdArray = Array.from(allItemIds);
        const itemIdsSql = itemIdArray.map((id) => sql`${id}`);

        const itemsResult = await db.execute(sql`
          SELECT
            li.id,
            li.server_id,
            s.name AS server_name,
            li.title,
            li.year,
            li.media_type,
            li.file_size::text AS file_size,
            li.video_resolution
          FROM library_items li
          JOIN servers s ON li.server_id = s.id
          WHERE li.id IN (${sql.join(itemIdsSql, sql`, `)})
        `);

        for (const row of itemsResult.rows as unknown as ItemDetailsRow[]) {
          itemDetailsMap.set(row.id, row);
        }
      }

      // Build duplicate groups from ID matches
      const duplicateGroups: DuplicateGroup[] = [];

      for (const match of idMatches) {
        const items: DuplicateItem[] = [];
        let totalSize = 0;
        let minSize = Infinity;

        for (const itemId of match.item_ids) {
          const details = itemDetailsMap.get(itemId);
          if (details) {
            const fileSize = details.file_size ? parseInt(details.file_size, 10) : null;
            items.push({
              id: details.id,
              serverId: details.server_id,
              serverName: details.server_name,
              title: details.title,
              year: details.year,
              mediaType: details.media_type,
              fileSize,
              resolution: details.video_resolution,
            });
            if (fileSize !== null) {
              totalSize += fileSize;
              minSize = Math.min(minSize, fileSize);
            }
          }
        }

        if (items.length >= 2) {
          duplicateGroups.push({
            matchKey: match.match_key,
            matchType: match.match_type,
            confidence: match.confidence,
            serverCount: match.server_count,
            items,
            totalStorageBytes: totalSize,
            potentialSavingsBytes: minSize !== Infinity ? totalSize - minSize : 0,
          });
        }
      }

      // Add fuzzy matches as duplicate groups
      // Group fuzzy matches by combining item pairs into groups
      const fuzzyGroupsMap = new Map<string, Set<string>>();
      for (const fuzzy of fuzzyMatches) {
        if (fuzzy.confidence >= minConfidence) {
          // Use the lower-confidence item's ID as the group key for consistency
          const groupKey = `fuzzy:${fuzzy.title_a.toLowerCase().substring(0, 50)}`;
          if (!fuzzyGroupsMap.has(groupKey)) {
            fuzzyGroupsMap.set(groupKey, new Set());
          }
          fuzzyGroupsMap.get(groupKey)!.add(fuzzy.item_a_id);
          fuzzyGroupsMap.get(groupKey)!.add(fuzzy.item_b_id);
        }
      }

      // Convert fuzzy groups to DuplicateGroup objects
      for (const [groupKey, itemIdSet] of fuzzyGroupsMap) {
        const items: DuplicateItem[] = [];
        let totalSize = 0;
        let minSize = Infinity;
        let avgConfidence = 70; // Default fuzzy confidence

        // Find the actual confidence for items in this group
        for (const fuzzy of fuzzyMatches) {
          if (itemIdSet.has(fuzzy.item_a_id) && itemIdSet.has(fuzzy.item_b_id)) {
            avgConfidence = Math.max(avgConfidence, fuzzy.confidence);
          }
        }

        const serverIds = new Set<string>();
        for (const itemId of itemIdSet) {
          const details = itemDetailsMap.get(itemId);
          if (details) {
            const fileSize = details.file_size ? parseInt(details.file_size, 10) : null;
            items.push({
              id: details.id,
              serverId: details.server_id,
              serverName: details.server_name,
              title: details.title,
              year: details.year,
              mediaType: details.media_type,
              fileSize,
              resolution: details.video_resolution,
            });
            serverIds.add(details.server_id);
            if (fileSize !== null) {
              totalSize += fileSize;
              minSize = Math.min(minSize, fileSize);
            }
          }
        }

        if (items.length >= 2 && serverIds.size >= 2) {
          duplicateGroups.push({
            matchKey: groupKey,
            matchType: 'fuzzy',
            confidence: avgConfidence,
            serverCount: serverIds.size,
            items,
            totalStorageBytes: totalSize,
            potentialSavingsBytes: minSize !== Infinity ? totalSize - minSize : 0,
          });
        }
      }

      // Sort by confidence descending
      duplicateGroups.sort((a, b) => b.confidence - a.confidence);

      // Calculate pagination
      const total = duplicateGroups.length;
      const offset = (page - 1) * pageSize;
      const paginatedGroups = duplicateGroups.slice(offset, offset + pageSize);

      // Calculate summary
      const summary: DuplicatesSummary = {
        totalGroups: total,
        totalDuplicateItems: duplicateGroups.reduce((sum, g) => sum + g.items.length, 0),
        totalPotentialSavingsBytes: duplicateGroups.reduce(
          (sum, g) => sum + g.potentialSavingsBytes,
          0
        ),
        byMatchType: {
          imdb: duplicateGroups.filter((g) => g.matchType === 'imdb').length,
          tmdb: duplicateGroups.filter((g) => g.matchType === 'tmdb').length,
          tvdb: duplicateGroups.filter((g) => g.matchType === 'tvdb').length,
          fuzzy: duplicateGroups.filter((g) => g.matchType === 'fuzzy').length,
        },
      };

      const response: DuplicatesResponse = {
        duplicates: paginatedGroups,
        summary,
        pagination: { page, pageSize, total },
      };

      // Cache for 1 hour (duplicates change slowly)
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_DUPLICATES, JSON.stringify(response));

      return response;
    }
  );
};
