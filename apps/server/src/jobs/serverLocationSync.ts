import { eq, ne, sql, type SQL } from 'drizzle-orm';
import { LOCAL_NETWORK_COUNTRY } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import {
  getCompressedSessionChunkRanges,
  uncapDecompressionForTx,
  type ChunkTimeRange,
} from '../db/timescale.js';
import { geoipService } from '../services/geoip.js';
import { locationRanges, type LocationRange } from '../services/serverLocationRanges.js';
import { loadServerLocations } from '../services/serverLocations.js';
import { localSessionSql } from '../db/sessions/rules.js';
import { uuidArraySql } from '../utils/sqlArrays.js';
import {
  drainWindowsWithBisection,
  sessionWalkWindows,
  ts,
  type BackfillWindow,
} from './sessionWalk.js';
import { MAX_POINT_UPDATES_PER_PASS } from './sessionIdentityBackfill.js';

export const LOCATION_SYNC_BATCH_SIZE = 1000;

/** A poll tick can resolve the old entries while the walk passes recent rows, so the end re-drains this far back. */
const TAIL_RECHECK_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CandidateRow {
  id: string;
  /** Postgres text, microseconds intact */
  started_at: string;
  ip_address: string;
  is_local: boolean | null;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function earlierOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Places one batch of the server's local rows. The candidates are read first, so a batch with
 * nothing to change opens no transaction. The rows are written by two statements bounded by the
 * batch's span, which decompress every compressed batch of the server that span reaches; up to
 * MAX_POINT_UPDATES_PER_PASS rows over a compressed chunk instead each take a point update on
 * constant (id, started_at), which decompresses only the batch holding the row.
 */
export async function syncLocationBatch(
  serverId: string,
  range: LocationRange,
  window: Required<BackfillWindow> | null,
  compressed: ChunkTimeRange[],
  batchSize = LOCATION_SYNC_BATCH_SIZE,
  /** The previous batch's oldest started_at. Inclusive: a row this walk wrote no longer matches, so only its unwritten ties come back. */
  before?: string
): Promise<{ count: number; oldest: Date | null; cursor?: string }> {
  const start = laterOf(range.from, window?.start ?? null);
  const end = earlierOf(range.to, window?.end ?? null);
  if (start && end && start >= end) return { count: 0, oldest: null };

  const place = range.location;
  const city = place?.city ?? null;
  const region = place?.region ?? null;
  const country = place?.country ?? LOCAL_NETWORK_COUNTRY;
  // Both sides as real: a float8 parameter never equals the stored float4, and the drain would never finish.
  const lat = place ? sql`${place.lat}::real` : sql`NULL::real`;
  const lon = place ? sql`${place.lon}::real` : sql`NULL::real`;
  const bounds = sql.join(
    [
      sql`s.server_id = ${serverId}::uuid`,
      ...(start ? [sql`s.started_at >= ${ts(start)}`] : []),
      ...(end ? [sql`s.started_at < ${ts(end)}`] : []),
      ...(before ? [sql`s.started_at <= ${before}::timestamptz`] : []),
    ],
    sql` AND `
  );

  const selected = await db.execute(sql`
    SELECT s.id, s.started_at, s.ip_address, s.is_local
    FROM sessions s
    WHERE ${bounds}
      AND ${localSessionSql('s')}
      AND (
        s.is_local IS NULL
        OR s.geo_city IS DISTINCT FROM ${city}::varchar
        OR s.geo_region IS DISTINCT FROM ${region}::varchar
        OR s.geo_country IS DISTINCT FROM ${country}::varchar
        OR s.geo_lat IS DISTINCT FROM ${lat}
        OR s.geo_lon IS DISTINCT FROM ${lon}
        OR s.geo_continent IS NOT NULL
        OR s.geo_postal IS NOT NULL
      )
    ORDER BY s.started_at DESC
    LIMIT ${batchSize}
  `);
  const rows = selected.rows as unknown as CandidateRow[];
  const newest = rows[0];
  const oldest = rows.at(-1);
  if (!newest || !oldest) return { count: 0, oldest: null };

  const placeRows: CandidateRow[] = [];
  const publicRows: CandidateRow[] = [];
  for (const row of rows) {
    (row.is_local === true || geoipService.isPrivateIP(row.ip_address)
      ? placeRows
      : publicRows
    ).push(row);
  }
  const placeSet = sql`
    is_local = true,
    geo_city = ${city},
    geo_region = ${region},
    geo_country = ${country},
    geo_lat = ${lat},
    geo_lon = ${lon},
    geo_continent = NULL,
    geo_postal = NULL`;
  // An old label said local but the IP is public: record that and leave the row's geo as it is.
  const publicSet = sql`is_local = false`;
  const pointUpdates =
    rows.length <= MAX_POINT_UPDATES_PER_PASS &&
    compressed.some(
      (chunk) =>
        chunk.end > new Date(oldest.started_at) && chunk.start <= new Date(newest.started_at)
    );

  await db.transaction(async (tx) => {
    await uncapDecompressionForTx(tx);
    if (pointUpdates) {
      const point = (set: SQL, row: CandidateRow) =>
        tx.execute(sql`
          UPDATE sessions SET ${set}
          WHERE id = ${row.id}::uuid AND started_at = ${row.started_at}::timestamptz
            AND server_id = ${serverId}::uuid
        `);
      for (const row of placeRows) await point(placeSet, row);
      for (const row of publicRows) await point(publicSet, row);
      return;
    }
    const inBatch = sql`server_id = ${serverId}::uuid
      AND started_at >= ${oldest.started_at}::timestamptz
      AND started_at <= ${newest.started_at}::timestamptz`;
    if (placeRows.length > 0) {
      await tx.execute(sql`
        UPDATE sessions SET ${placeSet}
        WHERE ${inBatch} AND id = ANY(${uuidArraySql(placeRows.map((row) => row.id))})
      `);
    }
    if (publicRows.length > 0) {
      await tx.execute(sql`
        UPDATE sessions SET ${publicSet}
        WHERE ${inBatch} AND id = ANY(${uuidArraySql(publicRows.map((row) => row.id))})
      `);
    }
  });
  return { count: rows.length, oldest: new Date(oldest.started_at), cursor: oldest.started_at };
}

function overlaps(window: Required<BackfillWindow>, range: LocationRange): boolean {
  return (
    (range.to === null || window.start < range.to) &&
    (range.from === null || window.end > range.from)
  );
}

export async function runServerLocationSyncWalk(deps: {
  scope: 'behind' | 'all';
  batchSize?: number;
  onBatch?: (total: number) => Promise<void>;
}): Promise<{ total: number; failedRanges: string[] }> {
  const batchSize = deps.batchSize ?? LOCATION_SYNC_BATCH_SIZE;
  const startedAt = Date.now();
  // Versions are read before the entries, so a save landing mid-run leaves its server behind.
  const snapshot = await db
    .select({
      id: servers.id,
      locationVersion: servers.locationVersion,
      locationSyncedVersion: servers.locationSyncedVersion,
    })
    .from(servers)
    .where(
      deps.scope === 'behind'
        ? ne(servers.locationVersion, servers.locationSyncedVersion)
        : undefined
    );
  const plans = [];
  for (const server of snapshot) {
    const entries = await loadServerLocations(server.id);
    // Never saved or imported with a location: readers already treat its labelled rows as local.
    const untouched =
      deps.scope === 'behind' &&
      entries.length === 0 &&
      server.locationVersion === 1 &&
      server.locationSyncedVersion === 0;
    plans.push({ ...server, ranges: untouched ? [] : locationRanges(entries) });
  }
  const windows = await sessionWalkWindows(null);
  // Callers run the walk with compression paused, so no chunk becomes compressed during it.
  const compressed = await getCompressedSessionChunkRanges();

  let total = 0;
  const failedRanges: string[] = [];
  const drain = async (
    serverId: string,
    range: LocationRange,
    rangeWindows: Required<BackfillWindow>[] | null
  ) => {
    const result = await drainWindowsWithBisection(
      rangeWindows,
      (window, before) => syncLocationBatch(serverId, range, window, compressed, batchSize, before),
      {
        batchSize,
        label: 'ServerLocationSync',
        onBatch: async (drained) => deps.onBatch?.(total + drained),
      }
    );
    total += result.total;
    failedRanges.push(...result.failedRanges);
  };

  for (const plan of plans) {
    for (const range of plan.ranges) {
      await drain(plan.id, range, windows && windows.filter((window) => overlaps(window, range)));
    }
  }
  const tail = [
    { start: new Date(startedAt - TAIL_RECHECK_MS), end: new Date(Date.now() + DAY_MS) },
  ];
  for (const plan of plans) {
    for (const range of plan.ranges) {
      await drain(
        plan.id,
        range,
        tail.filter((window) => overlaps(window, range))
      );
    }
  }

  if (failedRanges.length === 0) {
    for (const plan of plans) {
      await db
        .update(servers)
        .set({ locationSyncedVersion: plan.locationVersion })
        .where(eq(servers.id, plan.id));
    }
  }
  return { total, failedRanges };
}
