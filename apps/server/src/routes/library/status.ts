/**
 * Library Status Route
 *
 * GET /status - Check library sync and backfill status
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  libraryStatusQuerySchema,
  LEGACY_VERSION_SENTINEL,
  type LibraryStatusQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { isMaintenanceJobRunning } from '../../jobs/maintenanceQueue.js';
import { getLibrarySyncStatus } from '../../jobs/librarySyncQueue.js';
import { validLibraryItemCondition } from '../../utils/snapshotValidation.js';
import { libraryFragment, type Scope } from '../../lib/scope.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';

/** Library status response shape */
interface LibraryStatusResponse {
  /** Whether the library has been synced (has items) */
  isSynced: boolean;
  /** Whether a library sync is currently running */
  isSyncRunning: boolean;
  /** Whether historical snapshots need backfilling */
  needsBackfill: boolean;
  /** Whether the backfill job is currently running or queued */
  isBackfillRunning: boolean;
  /** State of the backfill job if running */
  backfillState: 'active' | 'waiting' | 'delayed' | null;
  /** Total library items count */
  itemCount: number;
  /** Total aggregate data points (days with data in library_stats_daily) */
  snapshotCount: number;
  /** Earliest item date (when first content was added) */
  earliestItemDate: string | null;
  /** Earliest date with aggregate data (from library_stats_daily) */
  earliestSnapshotDate: string | null;
  /** Days of history that could be backfilled */
  backfillDays: number | null;
  /** True while any 'legacy:1' version sentinel remains for the server, i.e.
   * items not yet re-scanned into real version rows. Cleared by a full sync. */
  versionsBackfillPending: boolean;
}

interface LibraryStatusRow {
  itemCount: number;
  snapshotCount: number;
  earliestItemDate: string | null;
  earliestSnapshotDate: string | null;
}

const EMPTY_ROW: LibraryStatusRow = {
  itemCount: 0,
  snapshotCount: 0,
  earliestItemDate: null,
  earliestSnapshotDate: null,
};

async function fetchLibraryStatusRows(
  serverIds: string[],
  scope: Scope
): Promise<Map<string, LibraryStatusRow>> {
  const idList = sql.join(
    serverIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  const itemFilter = libraryFragment(serverIds, scope, 'li');
  const snapshotFilter = libraryFragment(serverIds, scope, 'lsd');

  const result = await db.execute(sql`
    WITH item_agg AS (
      SELECT li.server_id,
        MIN(li.created_at) FILTER (WHERE ${validLibraryItemCondition('li')})::date AS earliest_item,
        COUNT(*)::int AS item_count
      FROM library_items li
      WHERE 1=1 AND li.removed_at IS NULL ${itemFilter}
      GROUP BY li.server_id
    ),
    snapshot_agg AS (
      SELECT lsd.server_id,
        MIN(lsd.day)::date AS earliest_snapshot,
        COUNT(DISTINCT lsd.day)::int AS snapshot_count
      FROM library_stats_daily lsd
      WHERE 1=1 ${snapshotFilter}
      GROUP BY lsd.server_id
    )
    SELECT
      sid.server_id,
      ia.earliest_item,
      sa.earliest_snapshot,
      COALESCE(ia.item_count, 0)::int AS item_count,
      COALESCE(sa.snapshot_count, 0)::int AS snapshot_count
    FROM unnest(ARRAY[${idList}]::uuid[]) AS sid(server_id)
    LEFT JOIN item_agg ia ON ia.server_id = sid.server_id
    LEFT JOIN snapshot_agg sa ON sa.server_id = sid.server_id
  `);

  const rows = result.rows as {
    server_id: string;
    earliest_item: string | null;
    earliest_snapshot: string | null;
    item_count: number;
    snapshot_count: number;
  }[];

  return new Map(
    rows.map((row) => [
      row.server_id,
      {
        itemCount: row.item_count,
        snapshotCount: row.snapshot_count,
        earliestItemDate: row.earliest_item,
        earliestSnapshotDate: row.earliest_snapshot,
      },
    ])
  );
}

/** Servers that still carry 'legacy:1' sentinels (backed by the partial
 * sentinel index, so this stays cheap and shrinks to empty as backfill
 * completes). Derived from data rather than a stored flag: Redis sync state
 * evaporates on flush and a stored flag drifts when a scan dies partway. */
async function fetchVersionsBackfillPending(
  serverIds: string[] | null | undefined
): Promise<Set<string>> {
  const filter = buildMultiServerFragment(serverIds ?? undefined, 'li.server_id');
  const result = await db.execute(sql`
    SELECT DISTINCT li.server_id
    FROM library_item_versions v
    JOIN library_items li ON li.id = v.library_item_id
    WHERE v.server_version_key = ${LEGACY_VERSION_SENTINEL}
      AND v.removed_at IS NULL
      ${filter}
  `);
  return new Set((result.rows as Array<{ server_id: string }>).map((r) => r.server_id));
}

function deriveLibraryStatus(
  row: LibraryStatusRow
): Pick<
  LibraryStatusResponse,
  | 'isSynced'
  | 'needsBackfill'
  | 'itemCount'
  | 'snapshotCount'
  | 'earliestItemDate'
  | 'earliestSnapshotDate'
  | 'backfillDays'
> {
  const { itemCount, snapshotCount, earliestItemDate, earliestSnapshotDate } = row;
  const isSynced = itemCount > 0;

  let needsBackfill = false;
  let backfillDays: number | null = null;

  if (isSynced) {
    if (snapshotCount === 0) {
      needsBackfill = true;
      if (earliestItemDate) {
        backfillDays = Math.floor(
          (Date.now() - new Date(earliestItemDate).getTime()) / (1000 * 60 * 60 * 24)
        );
      }
    } else if (earliestItemDate && earliestSnapshotDate) {
      const itemDate = new Date(earliestItemDate);
      const snapshotDate = new Date(earliestSnapshotDate);
      if (itemDate < snapshotDate) {
        needsBackfill = true;
        backfillDays = Math.floor(
          (snapshotDate.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24)
        );
      }
    }
  }

  return {
    isSynced,
    needsBackfill,
    itemCount,
    snapshotCount,
    earliestItemDate,
    earliestSnapshotDate,
    backfillDays,
  };
}

export const libraryStatusRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /status - Check library sync and backfill status
   *
   * Returns information about whether the library needs syncing or backfilling.
   * Used by frontend to show appropriate empty states and action buttons.
   */
  app.get<{ Querystring: LibraryStatusQueryInput }>(
    '/status',
    { preHandler: [app.requirePermission('media', 'read')] },
    async (request, reply) => {
      const query = libraryStatusQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds } = query.data;
      const authUser = request.user;
      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      const backfillStatus = await isMaintenanceJobRunning('backfill_library_snapshots');

      if (serverIds) {
        const targetIds = resolvedIds ?? [];
        const [rowsById, syncStatuses, sentinelServers] = await Promise.all([
          fetchLibraryStatusRows(targetIds, request.scope),
          Promise.all(targetIds.map((id) => getLibrarySyncStatus(id))),
          fetchVersionsBackfillPending(targetIds),
        ]);

        const response: Record<string, LibraryStatusResponse> = {};
        targetIds.forEach((id, i) => {
          response[id] = {
            ...deriveLibraryStatus(rowsById.get(id) ?? EMPTY_ROW),
            isSyncRunning: syncStatuses[i]?.isActive ?? false,
            isBackfillRunning: backfillStatus.isRunning,
            backfillState: backfillStatus.state,
            versionsBackfillPending: sentinelServers.has(id),
          };
        });

        return reply.send(response);
      }

      if (serverId && resolvedIds) {
        const [rowsById, syncStatus, sentinelServers] = await Promise.all([
          fetchLibraryStatusRows(resolvedIds, request.scope),
          getLibrarySyncStatus(serverId),
          fetchVersionsBackfillPending(resolvedIds),
        ]);

        return reply.send({
          ...deriveLibraryStatus(rowsById.get(serverId) ?? EMPTY_ROW),
          isSyncRunning: syncStatus?.isActive ?? false,
          isBackfillRunning: backfillStatus.isRunning,
          backfillState: backfillStatus.state,
          versionsBackfillPending: sentinelServers.has(serverId),
        } satisfies LibraryStatusResponse);
      }

      // No explicit server: combined totals, scoped to accessible servers and libraries for members.
      const itemFilter = libraryFragment(resolvedIds, request.scope, 'li');
      const snapshotFilter = libraryFragment(resolvedIds, request.scope, 'lsd');
      const result = await db.execute(sql`
        SELECT
          (SELECT MIN(li.created_at)::date FROM library_items li
           WHERE ${validLibraryItemCondition('li')} AND li.removed_at IS NULL ${itemFilter}) AS earliest_item,
          (SELECT MIN(lsd.day)::date FROM library_stats_daily lsd
           WHERE 1=1 ${snapshotFilter}) AS earliest_snapshot,
          (SELECT COUNT(*)::int FROM library_items li WHERE 1=1 AND li.removed_at IS NULL ${itemFilter}) AS item_count,
          (SELECT COUNT(DISTINCT lsd.day)::int FROM library_stats_daily lsd
           WHERE 1=1 ${snapshotFilter}) AS snapshot_count
      `);

      const row = result.rows[0] as {
        earliest_item: string | null;
        earliest_snapshot: string | null;
        item_count: number;
        snapshot_count: number;
      };

      return reply.send({
        ...deriveLibraryStatus({
          itemCount: row.item_count ?? 0,
          snapshotCount: row.snapshot_count ?? 0,
          earliestItemDate: row.earliest_item,
          earliestSnapshotDate: row.earliest_snapshot,
        }),
        isSyncRunning: false,
        isBackfillRunning: backfillStatus.isRunning,
        backfillState: backfillStatus.state,
        versionsBackfillPending: (await fetchVersionsBackfillPending(resolvedIds)).size > 0,
      } satisfies LibraryStatusResponse);
    }
  );
};
