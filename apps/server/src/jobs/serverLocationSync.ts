import { eq, ne, sql } from 'drizzle-orm';
import { LOCAL_NETWORK_COUNTRY } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { uncapDecompressionForTx } from '../db/timescale.js';
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

export async function syncLocationBatch(
  serverId: string,
  range: LocationRange,
  window: Required<BackfillWindow> | null,
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

  return db.transaction(async (tx) => {
    await uncapDecompressionForTx(tx);
    const selected = await tx.execute(sql`
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

    const placeIds: string[] = [];
    const publicIds: string[] = [];
    for (const row of rows) {
      (row.is_local === true || geoipService.isPrivateIP(row.ip_address)
        ? placeIds
        : publicIds
      ).push(row.id);
    }
    const inBatch = sql`server_id = ${serverId}::uuid
      AND started_at >= ${oldest.started_at}::timestamptz
      AND started_at <= ${newest.started_at}::timestamptz`;

    if (placeIds.length > 0) {
      await tx.execute(sql`
        UPDATE sessions SET
          is_local = true,
          geo_city = ${city},
          geo_region = ${region},
          geo_country = ${country},
          geo_lat = ${lat},
          geo_lon = ${lon},
          geo_continent = NULL,
          geo_postal = NULL
        WHERE ${inBatch} AND id = ANY(${uuidArraySql(placeIds)})
      `);
    }
    // An old label said local but the IP is public: record that and leave the row's geo as it is.
    if (publicIds.length > 0) {
      await tx.execute(sql`
        UPDATE sessions SET is_local = false
        WHERE ${inBatch} AND id = ANY(${uuidArraySql(publicIds)})
      `);
    }
    return { count: rows.length, oldest: new Date(oldest.started_at), cursor: oldest.started_at };
  });
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

  let total = 0;
  const failedRanges: string[] = [];
  const drain = async (
    serverId: string,
    range: LocationRange,
    rangeWindows: Required<BackfillWindow>[] | null
  ) => {
    const result = await drainWindowsWithBisection(
      rangeWindows,
      (window, before) => syncLocationBatch(serverId, range, window, batchSize, before),
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
