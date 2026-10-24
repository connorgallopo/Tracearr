import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { ResolutionBucket } from '@tracearr/shared';
import { db } from './client.js';
import { librarySnapshots } from './schema.js';
import { perResolutionBucket } from '../utils/resolutionBuckets.js';

const RECENT_SNAPSHOT_MS = 7 * 24 * 60 * 60 * 1000;

const recentSnapshotFloor = () => new Date(Date.now() - RECENT_SNAPSHOT_MS);

export type LatestSnapshotRow = {
  server_id: string;
  library_id: string;
  item_count: number;
  total_size: string;
  movie_count: number;
  episode_count: number;
  show_count: number;
  snapshot_time: string;
} & Record<`count_${ResolutionBucket}`, number>;

async function latestPerLibrary(where: SQL): Promise<LatestSnapshotRow[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (ls.server_id, ls.library_id)
      ls.server_id,
      ls.library_id,
      ls.item_count,
      ls.total_size,
      ls.movie_count,
      ls.episode_count,
      ls.show_count,
      ${perResolutionBucket((bucket) => `ls.count_${bucket}`)},
      ls.snapshot_time
    FROM library_snapshots ls
    WHERE ${where}
    ORDER BY ls.server_id, ls.library_id, ls.snapshot_time DESC
  `);
  return result.rows as LatestSnapshotRow[];
}

/**
 * Latest row per library in scope: a 7-day read first, then the unbounded read for the
 * libraries the window missed. The filters are fragments over the alias `ls`. The libraries
 * in scope come from the snapshots themselves, not the libraries table, so a library whose
 * row is gone but whose snapshots remain still counts.
 */
export async function latestSnapshotPerLibrary(filters: {
  serverFragment: SQL;
  libraryFilter: SQL;
}): Promise<LatestSnapshotRow[]> {
  const { serverFragment, libraryFilter } = filters;
  const [recent, inScope] = await Promise.all([
    latestPerLibrary(
      sql`ls.snapshot_time >= ${recentSnapshotFloor()} ${serverFragment} ${libraryFilter}`
    ),
    db.execute(sql`
      SELECT DISTINCT ls.server_id, ls.library_id
      FROM library_snapshots ls
      WHERE 1=1 ${serverFragment} ${libraryFilter}
    `),
  ]);
  const found = new Set(recent.map((row) => `${row.server_id}:${row.library_id}`));
  const missed = (inScope.rows as { server_id: string; library_id: string }[]).filter(
    (row) => !found.has(`${row.server_id}:${row.library_id}`)
  );
  if (missed.length === 0) return recent;
  const pairs = sql.join(
    missed.map((row) => sql`(${row.server_id}::uuid, ${row.library_id})`),
    sql`, `
  );
  return [...recent, ...(await latestPerLibrary(sql`(ls.server_id, ls.library_id) IN (${pairs})`))];
}

/** The library's latest snapshot: the last 7 days first, then the whole history on a miss. */
export async function latestSnapshotFor(
  serverId: string,
  libraryId: string
): Promise<typeof librarySnapshots.$inferSelect | undefined> {
  const read = async (floor?: Date) => {
    const [row] = await db
      .select()
      .from(librarySnapshots)
      .where(
        and(
          eq(librarySnapshots.serverId, serverId),
          eq(librarySnapshots.libraryId, libraryId),
          floor ? gte(librarySnapshots.snapshotTime, floor) : undefined
        )
      )
      .orderBy(desc(librarySnapshots.snapshotTime))
      .limit(1);
    return row;
  };
  return (await read(recentSnapshotFloor())) ?? read();
}
