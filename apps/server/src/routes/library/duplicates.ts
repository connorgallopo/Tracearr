/**
 * Library Duplicates Route
 *
 * GET /duplicates - a duplicate is a title with two or more DISTINCT
 * physical files (distinct byte size, the same mirror heuristic the storage
 * totals use). Mirror-only groups never ship, which keeps mirrored
 * multi-server deployments from drowning real duplicates in zero-savings
 * noise; the single-server case matches Plex's own Duplicates filter.
 *
 * Matching hierarchy: imdb 100 > tmdb 95 > tvdb 90 > fuzzy 60-100;
 * single-item groups present as 'version' at 100. Reclaimable = deduped
 * total minus the best-quality file. An episode's key also carries its
 * season and episode number: Plex's agents attach another episode's id to
 * an item often enough that the id alone pairs two different episodes (#1223).
 *
 * Grouping, the gate, and the summary run in one SQL statement and the route
 * hydrates one page only - building every group in Node exceeded postgres's
 * 65535 bind-parameter cap on large mirrored installs.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryDuplicatesQuerySchema,
  type LibraryDuplicatesQueryInput,
  type MatchType,
  type DuplicateItem,
  type DuplicateItemVersion,
  type DuplicateGroup,
  type DuplicatesSummary,
  type DuplicatesResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  validateServerAccess,
  resolveServerIds,
  buildMultiServerFragment,
} from '../../utils/serverFiltering.js';
import { resolutionRankSql } from '../../utils/resolutionBuckets.js';
import { buildLibraryCacheKey } from './utils.js';

/** One group row from the paginated group query, window summary included */
interface RawGroupRow {
  group_key: string;
  match_type: MatchType;
  confidence: number;
  item_ids: string[];
  item_count: number;
  server_count: number;
  unique_file_count: number;
  total_bytes: string;
  savings_bytes: string;
  total_groups: number;
  total_duplicate_items: number;
  total_savings_bytes: string;
  imdb_groups: number;
  tmdb_groups: number;
  tvdb_groups: number;
  fuzzy_groups: number;
  version_groups: number;
}

/** Raw item details row */
interface ItemDetailsRow {
  id: string;
  server_id: string;
  server_name: string;
  library_id: string | null;
  library_name: string | null;
  title: string;
  year: number | null;
  media_type: string;
  grandparent_title: string | null;
  parent_index: number | null;
  item_index: number | null;
  file_size: string | null;
  video_resolution: string | null;
}

interface VersionRow {
  library_item_id: string;
  server_version_key: string;
  video_resolution: string | null;
  video_codec: string | null;
  file_size: string | null;
  file_path: string | null;
}

interface GroupFile {
  itemId: string;
  fileSize: number | null;
}

/**
 * Mirror flags over every physical file in a group, parallel to the input:
 * true where a file repeats a byte size already counted. The group's storage
 * math (distinct count, total, reclaimable) comes from the SQL group query so
 * page rows always agree with the gate and the summary; this only marks which
 * listings are repeats for display.
 */
function computeMirrorFlags(files: GroupFile[]): boolean[] {
  const seenSizes = new Set<number>();
  const mirrorFlags: boolean[] = [];
  for (const file of files) {
    if (file.fileSize === null) {
      mirrorFlags.push(false);
      continue;
    }
    if (seenSizes.has(file.fileSize)) {
      mirrorFlags.push(true);
      continue;
    }
    seenSizes.add(file.fileSize);
    mirrorFlags.push(false);
  }
  return mirrorFlags;
}

export const libraryDuplicatesRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: LibraryDuplicatesQueryInput }>(
    '/duplicates',
    { preHandler: [app.requirePermission('insights', 'read')] },
    async (request, reply) => {
      const query = libraryDuplicatesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds: rawServerIds,
        mediaType,
        minConfidence,
        includeFuzzy,
        page,
        pageSize,
      } = query.data;
      const authUser = request.user;

      // Validate single-server access when serverId explicitly requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      const resolvedIds = resolveServerIds(authUser, undefined, rawServerIds);

      // Build cache key with all varying params. serverId here is an involvement
      // filter, not the scope filter, so it must be a separate segment from
      // resolvedIds or two differently-scoped users requesting the same
      // involvement filter would collide.
      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_DUPLICATES,
        `${serverCacheSegment}:${serverId ?? 'any'}`,
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

      // resolvedIds already intersects user access with any requested serverIds
      const serverFilterSql = buildMultiServerFragment(resolvedIds);
      const mediaTypeFilter = mediaType ? sql`AND media_type = ${mediaType}` : sql``;

      const fuzzyEnabled = includeFuzzy && minConfidence <= 70;

      /**
       * One statement: membership -> per-group distinct-file math -> gate ->
       * summary via window aggregates -> one ordered page. media_type is
       * folded into the id key so a show and an episode sharing a TVDB id
       * cannot collapse, and an episode's season and episode number are
       * folded in so a foreign id on one episode cannot pair it with another;
       * fuzzy only feeds items with no external IDs.
       */
      const runGroupQuery = async (offset: number) => {
        const result = await db.execute(sql`
          WITH scoped AS (
            SELECT id, server_id, media_type, title, grandparent_title, year,
                   imdb_id, tmdb_id, tvdb_id, file_size, video_resolution,
                   CASE
                     WHEN media_type = 'episode' AND parent_index IS NOT NULL AND item_index IS NOT NULL
                       THEN ':s' || parent_index || 'e' || item_index
                     ELSE ''
                   END AS episode_key
            FROM library_items
            WHERE removed_at IS NULL
              AND media_type != 'season'
              ${serverFilterSql}
              ${mediaTypeFilter}
          ),
          fuzzy_pairs AS (
            ${
              fuzzyEnabled
                ? sql`
            SELECT a.id AS item_a_id, b.id AS item_b_id,
                   CASE WHEN a.media_type = 'episode'
                     THEN a.grandparent_title || ' ' || a.title
                     ELSE a.title
                   END AS title_a,
                   a.episode_key AS episode_key_a,
                   ROUND(similarity(a.title, b.title) * 100)::int AS confidence
            FROM scoped a
            JOIN scoped b ON a.id < b.id
              AND a.media_type = b.media_type
              AND a.year = b.year
              AND a.episode_key = b.episode_key
            WHERE a.imdb_id IS NULL AND a.tmdb_id IS NULL AND a.tvdb_id IS NULL
              AND b.imdb_id IS NULL AND b.tmdb_id IS NULL AND b.tvdb_id IS NULL
              AND similarity(a.title, b.title) >= 0.6
              AND (
                a.media_type != 'episode'
                OR (
                  a.grandparent_title IS NOT NULL
                  AND b.grandparent_title IS NOT NULL
                  AND similarity(a.grandparent_title, b.grandparent_title) >= 0.6
                )
              )
            ORDER BY confidence DESC
            LIMIT 100`
                : sql`
            SELECT NULL::uuid AS item_a_id, NULL::uuid AS item_b_id,
                   NULL::text AS title_a, NULL::text AS episode_key_a,
                   NULL::int AS confidence
            WHERE false`
            }
          ),
          fuzzy_keys AS (
            SELECT item_id, MIN(fuzzy_key) AS fuzzy_key, MAX(confidence) AS confidence
            FROM (
              SELECT item_a_id AS item_id,
                     'fuzzy:' || lower(left(title_a, 50)) || episode_key_a AS fuzzy_key, confidence
              FROM fuzzy_pairs
              UNION ALL
              SELECT item_b_id, 'fuzzy:' || lower(left(title_a, 50)) || episode_key_a, confidence
              FROM fuzzy_pairs
            ) fp
            GROUP BY item_id
          ),
          membership AS (
            SELECT s.id, s.server_id, s.file_size, s.video_resolution,
              CASE
                WHEN s.imdb_id IS NOT NULL THEN 'imdb:' || s.media_type || ':' || s.imdb_id || s.episode_key
                WHEN s.tmdb_id IS NOT NULL THEN 'tmdb:' || s.media_type || ':' || s.tmdb_id::text || s.episode_key
                WHEN s.tvdb_id IS NOT NULL THEN 'tvdb:' || s.media_type || ':' || s.tvdb_id::text || s.episode_key
                WHEN fk.fuzzy_key IS NOT NULL THEN fk.fuzzy_key
                ELSE 'version:' || s.id::text
              END AS group_key,
              CASE
                WHEN s.imdb_id IS NOT NULL THEN 'imdb'
                WHEN s.tmdb_id IS NOT NULL THEN 'tmdb'
                WHEN s.tvdb_id IS NOT NULL THEN 'tvdb'
                WHEN fk.fuzzy_key IS NOT NULL THEN 'fuzzy'
                ELSE 'version'
              END AS key_type,
              fk.confidence AS fuzzy_confidence
            FROM scoped s
            LEFT JOIN fuzzy_keys fk ON fk.item_id = s.id
          ),
          files AS (
            -- One row per (item, physical listing). Items with no version
            -- rows fall back to their flat rollup columns; versions carrying
            -- NULL sizes keep the NULL. Single-referenced so the planner
            -- inlines it - no CTE fence, no stats cliff.
            SELECT m.group_key, m.key_type, m.fuzzy_confidence, m.id, m.server_id,
              CASE WHEN v.id IS NULL THEN m.file_size ELSE v.file_size END AS size,
              ${resolutionRankSql(
                'CASE WHEN v.id IS NULL THEN m.video_resolution ELSE v.video_resolution END'
              )} AS res_rank
            FROM membership m
            LEFT JOIN library_item_versions v
              ON v.library_item_id = m.id AND v.removed_at IS NULL
          ),
          groups AS (
            -- One aggregation pass computes membership AND the mirror-deduped
            -- storage math (SUM/COUNT DISTINCT size implement "equal byte
            -- size = the same physical file"; repeats of a size never change
            -- the best-file winner). Folding the math in here rather than
            -- joining two aggregated CTEs matters: aggregate output sizes are
            -- planner guesses, and the misestimated join nested-loops into
            -- minutes at ~45k groups.
            SELECT f.group_key,
              MIN(f.key_type) AS key_type,
              COUNT(DISTINCT f.id)::int AS item_count,
              array_agg(DISTINCT f.id ORDER BY f.id) AS item_ids,
              COUNT(DISTINCT f.server_id)::int AS server_count,
              array_agg(DISTINCT f.server_id) AS server_ids,
              MAX(f.fuzzy_confidence) AS fuzzy_confidence,
              COUNT(DISTINCT f.size)::int AS unique_file_count,
              SUM(DISTINCT f.size)::bigint AS total_bytes,
              (array_agg(f.size ORDER BY f.res_rank DESC, f.size DESC)
                FILTER (WHERE f.size IS NOT NULL))[1]::bigint AS best_size
            FROM files f
            GROUP BY f.group_key
          ),
          gated AS (
            SELECT g.group_key,
              CASE WHEN g.item_count = 1 THEN 'version' ELSE g.key_type END AS match_type,
              CASE
                WHEN g.item_count = 1 THEN 100
                WHEN g.key_type = 'imdb' THEN 100
                WHEN g.key_type = 'tmdb' THEN 95
                WHEN g.key_type = 'tvdb' THEN 90
                ELSE COALESCE(g.fuzzy_confidence, 70)
              END AS confidence,
              g.item_ids, g.item_count, g.server_count,
              g.unique_file_count, g.total_bytes,
              GREATEST(g.total_bytes - g.best_size, 0)::bigint AS savings_bytes
            FROM groups g
            WHERE g.unique_file_count >= 2
              ${serverId ? sql`AND ${serverId} = ANY(g.server_ids)` : sql``}
          ),
          filtered AS (
            SELECT * FROM gated WHERE confidence >= ${minConfidence}
          )
          SELECT group_key, match_type, confidence, item_ids, item_count,
            server_count, unique_file_count,
            total_bytes::text, savings_bytes::text,
            COUNT(*) OVER ()::int AS total_groups,
            SUM(item_count) OVER ()::int AS total_duplicate_items,
            SUM(savings_bytes) OVER ()::text AS total_savings_bytes,
            (COUNT(*) FILTER (WHERE match_type = 'imdb') OVER ())::int AS imdb_groups,
            (COUNT(*) FILTER (WHERE match_type = 'tmdb') OVER ())::int AS tmdb_groups,
            (COUNT(*) FILTER (WHERE match_type = 'tvdb') OVER ())::int AS tvdb_groups,
            (COUNT(*) FILTER (WHERE match_type = 'fuzzy') OVER ())::int AS fuzzy_groups,
            (COUNT(*) FILTER (WHERE match_type = 'version') OVER ())::int AS version_groups
          FROM filtered
          ORDER BY savings_bytes DESC, group_key
          LIMIT ${pageSize} OFFSET ${offset}
        `);
        return result.rows as unknown as RawGroupRow[];
      };

      const groupRows = await runGroupQuery((page - 1) * pageSize);
      // A page past the end returns no rows and loses the window summary;
      // refetch page 1 for the totals and serve an empty page honestly
      if (groupRows.length === 0 && page > 1) {
        const firstPage = await runGroupQuery(0);
        const summarySource = firstPage[0];
        const response = buildResponse([], summarySource, page, pageSize);
        await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_DUPLICATES, JSON.stringify(response));
        return response;
      }

      // Hydrate details for this page's items only
      const pageItemIds = Array.from(new Set(groupRows.flatMap((row) => row.item_ids)));
      const itemDetailsMap = new Map<string, ItemDetailsRow>();
      const versionsByItem = new Map<string, DuplicateItemVersion[]>();
      if (pageItemIds.length > 0) {
        const idsArray = `{${pageItemIds.join(',')}}`;

        const itemsResult = await db.execute(sql`
          SELECT
            li.id,
            li.server_id,
            s.name AS server_name,
            li.library_id,
            l.name AS library_name,
            li.title,
            li.year,
            li.media_type,
            li.grandparent_title,
            li.parent_index,
            li.item_index,
            li.file_size::text AS file_size,
            li.video_resolution
          FROM library_items li
          JOIN servers s ON li.server_id = s.id
          LEFT JOIN libraries l ON l.server_id = li.server_id AND l.library_id = li.library_id
          WHERE li.id = ANY(${idsArray}::uuid[])
            AND li.removed_at IS NULL
        `);
        for (const row of itemsResult.rows as unknown as ItemDetailsRow[]) {
          itemDetailsMap.set(row.id, row);
        }

        // Sentinel rows count too: they carry the real file's size and path
        // for items not yet re-scanned into observed versions
        const versionsResult = await db.execute(sql`
          SELECT
            library_item_id,
            server_version_key,
            video_resolution,
            video_codec,
            file_size::text AS file_size,
            file_path
          FROM library_item_versions
          WHERE library_item_id = ANY(${idsArray}::uuid[])
            AND removed_at IS NULL
          ORDER BY library_item_versions.file_size DESC NULLS LAST, library_item_versions.server_version_key ASC
        `);
        for (const row of versionsResult.rows as unknown as VersionRow[]) {
          const list = versionsByItem.get(row.library_item_id) ?? [];
          list.push({
            serverVersionKey: row.server_version_key,
            resolution: row.video_resolution,
            videoCodec: row.video_codec,
            fileSize: row.file_size ? parseInt(row.file_size, 10) : null,
            filePath: row.file_path,
          });
          versionsByItem.set(row.library_item_id, list);
        }
      }

      const toDuplicateItem = (details: ItemDetailsRow): DuplicateItem => ({
        id: details.id,
        serverId: details.server_id,
        serverName: details.server_name,
        libraryId: details.library_id,
        libraryName: details.library_name,
        title: details.title,
        year: details.year,
        mediaType: details.media_type,
        grandparentTitle: details.grandparent_title,
        seasonNumber: details.parent_index,
        episodeNumber: details.item_index,
        fileSize: details.file_size ? parseInt(details.file_size, 10) : null,
        resolution: details.video_resolution,
        versions: versionsByItem.get(details.id) ?? [],
      });

      /** Every physical file across the group's items, for the mirror flags */
      const groupFiles = (items: DuplicateItem[]): GroupFile[] =>
        items.flatMap((item) =>
          item.versions.length > 0
            ? item.versions.map((v) => ({ itemId: item.id, fileSize: v.fileSize }))
            : [{ itemId: item.id, fileSize: item.fileSize }]
        );

      const buildGroup = (row: RawGroupRow, items: DuplicateItem[]): DuplicateGroup => {
        const mirrorFlags = computeMirrorFlags(groupFiles(items));

        // Copy version lists while attaching mirror flags: versionsByItem
        // arrays are shared across groups, so flags must never mutate them.
        // groupFiles flattened in item order, one entry per version (or one
        // fallback entry for version-less items), so the flags line up.
        let fileIndex = 0;
        const flaggedItems = items.map((item) => {
          if (item.versions.length === 0) {
            fileIndex += 1;
            return item;
          }
          const versions = item.versions.map((version) => {
            const isMirror = mirrorFlags[fileIndex] === true;
            fileIndex += 1;
            return isMirror ? { ...version, isMirror: true } : { ...version };
          });
          return { ...item, versions };
        });

        return {
          matchKey: row.group_key,
          matchType: row.match_type,
          confidence: row.confidence,
          serverCount: row.server_count,
          sameServer: row.server_count === 1,
          items: flaggedItems,
          uniqueFileCount: row.unique_file_count,
          totalStorageBytes: Number(row.total_bytes),
          potentialSavingsBytes: Number(row.savings_bytes),
        };
      };

      const duplicateGroups = groupRows.map((row) =>
        buildGroup(
          row,
          row.item_ids
            .map((id) => itemDetailsMap.get(id))
            .filter((details): details is ItemDetailsRow => details !== undefined)
            .map(toDuplicateItem)
        )
      );

      const response = buildResponse(duplicateGroups, groupRows[0], page, pageSize);

      // Cache for 1 hour (duplicates change slowly)
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_DUPLICATES, JSON.stringify(response));

      return response;
    }
  );
};

/** Assemble the response from page groups and the window summary of any row */
function buildResponse(
  duplicateGroups: DuplicateGroup[],
  summarySource: RawGroupRow | undefined,
  page: number,
  pageSize: number
): DuplicatesResponse {
  const summary: DuplicatesSummary = {
    totalGroups: summarySource?.total_groups ?? 0,
    totalDuplicateItems: summarySource?.total_duplicate_items ?? 0,
    totalPotentialSavingsBytes: Number(summarySource?.total_savings_bytes ?? 0),
    byMatchType: {
      imdb: summarySource?.imdb_groups ?? 0,
      tmdb: summarySource?.tmdb_groups ?? 0,
      tvdb: summarySource?.tvdb_groups ?? 0,
      fuzzy: summarySource?.fuzzy_groups ?? 0,
      version: summarySource?.version_groups ?? 0,
    },
  };

  return {
    duplicates: duplicateGroups,
    summary,
    pagination: { page, pageSize, total: summary.totalGroups },
  };
}
