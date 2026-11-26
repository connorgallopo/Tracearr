/**
 * Server location sync against real TimescaleDB: placement, dated moves, removal back to the
 * exact Local Network shape, convergence, a server that never had a location, the remote
 * predicate, and a save during a run.
 *
 * Run with: pnpm test:integration
 */
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db, recreatePool } from '../client.js';
import { servers } from '../schema.js';
import { runServerLocationSyncWalk } from '../../jobs/serverLocationSync.js';
import { MAX_POINT_UPDATES_PER_PASS } from '../timescale.js';
import { getServerLocations, replaceServerLocations } from '../../services/serverLocations.js';
import { localSessionSql } from '../../db/sessions/rules.js';
import { compressSessionChunks } from '../../test/compressChunks.js';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const FILLER_SESSIONS = 40;
const CHICAGO = { lat: 41.8781, lon: -87.6298, city: 'Chicago', region: 'Illinois', country: 'US' };
const DENVER = { lat: 39.7392, lon: -104.9903, city: 'Denver', region: 'Colorado', country: 'US' };

interface GeoRow {
  is_local: boolean | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_country: string | null;
  geo_continent: string | null;
  geo_postal: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
}

async function geoOf(id: string): Promise<GeoRow> {
  const result = await db.execute(sql`
    SELECT is_local, geo_city, geo_region, geo_country, geo_continent, geo_postal, geo_lat, geo_lon
    FROM sessions WHERE id = ${id}::uuid
  `);
  const row = result.rows[0] as GeoRow | undefined;
  if (!row) throw new Error(`session ${id} missing`);
  return row;
}

async function bumpVersion(serverId: string) {
  await db
    .update(servers)
    .set({ locationVersion: sql`${servers.locationVersion} + 1` })
    .where(eq(servers.id, serverId));
}

async function setEntries(
  serverId: string,
  entries: Array<typeof CHICAGO & { effectiveFrom: Date | null }>
) {
  await replaceServerLocations(
    serverId,
    entries.map((entry) => ({
      ...entry,
      effectiveFrom: entry.effectiveFrom?.toISOString() ?? null,
    }))
  );
}

async function seed() {
  const server = await createTestServer();
  const user = await createTestUser();
  const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });
  const base = { serverId: server.id, serverUserId: serverUser.id };
  const old = new Date(Date.now() - 60 * DAY);
  const recent = new Date(Date.now() - 2 * 60 * 60 * 1000);

  const oldLocal = await createTestSession({ ...base, ipAddress: '192.168.1.20', startedAt: old });
  const oldFormat = await createTestSession({ ...base, ipAddress: '10.0.0.5', startedAt: old });
  const recentLocal = await createTestSession({
    ...base,
    ipAddress: '192.168.1.21',
    startedAt: recent,
  });
  const remote = await createTestSession({ ...base, ipAddress: '8.8.8.8', startedAt: recent });
  const labelledPublic = await createTestSession({
    ...base,
    ipAddress: '8.8.4.4',
    startedAt: recent,
  });

  await db.execute(sql`
    UPDATE sessions SET geo_city = NULL, geo_region = NULL, geo_country = 'Local Network',
      geo_lat = NULL, geo_lon = NULL, geo_asn_number = NULL, geo_asn_organization = NULL
    WHERE id IN (${oldLocal.id}::uuid, ${recentLocal.id}::uuid, ${labelledPublic.id}::uuid)
  `);
  await db.execute(sql`
    UPDATE sessions SET geo_city = 'Local', geo_region = NULL, geo_country = NULL,
      geo_lat = NULL, geo_lon = NULL
    WHERE id = ${oldFormat.id}::uuid
  `);
  await compressSessionChunks(30);
  return { server, oldLocal, oldFormat, recentLocal, remote, labelledPublic, recent };
}

describe('server location sync', () => {
  it('places local rows, fixes the old format, and leaves remote rows alone', async () => {
    const s = await seed();
    await setEntries(s.server.id, [{ ...CHICAGO, effectiveFrom: null }]);
    expect(await getServerLocations(s.server.id)).toEqual({
      entries: [
        {
          ...CHICAGO,
          effectiveFrom: null,
          lat: expect.closeTo(CHICAGO.lat, 4),
          lon: expect.closeTo(CHICAGO.lon, 4),
        },
      ],
      syncPending: true,
    });

    await runServerLocationSyncWalk({ scope: 'behind' });

    expect((await getServerLocations(s.server.id))?.syncPending).toBe(false);
    for (const id of [s.oldLocal.id, s.oldFormat.id, s.recentLocal.id]) {
      const row = await geoOf(id);
      expect(row).toMatchObject({ is_local: true, geo_city: 'Chicago', geo_country: 'US' });
      expect(row.geo_lat).toBeCloseTo(41.8781, 4);
    }
    expect(await geoOf(s.remote.id)).toMatchObject({ is_local: null, geo_city: 'New York' });
    expect(await geoOf(s.labelledPublic.id)).toMatchObject({
      is_local: false,
      geo_country: 'Local Network',
      geo_lat: null,
    });
    const [synced] = await db
      .select({ v: servers.locationVersion, s: servers.locationSyncedVersion })
      .from(servers)
      .where(eq(servers.id, s.server.id));
    expect(synced?.s).toBe(synced?.v);
  });

  it('converges: a second run writes nothing', async () => {
    const s = await seed();
    await setEntries(s.server.id, [{ ...CHICAGO, effectiveFrom: null }]);
    await runServerLocationSyncWalk({ scope: 'behind' });
    await bumpVersion(s.server.id);

    const second = await runServerLocationSyncWalk({ scope: 'behind' });

    expect(second.total).toBe(0);
  });

  it('splits history at a dated move', async () => {
    const s = await seed();
    await setEntries(s.server.id, [
      { ...CHICAGO, effectiveFrom: null },
      { ...DENVER, effectiveFrom: new Date(Date.now() - DAY) },
    ]);

    await runServerLocationSyncWalk({ scope: 'behind' });

    expect((await geoOf(s.oldLocal.id)).geo_city).toBe('Chicago');
    expect((await geoOf(s.recentLocal.id)).geo_city).toBe('Denver');
  });

  it('puts the exact Local Network shape back when the location is removed', async () => {
    const s = await seed();
    await setEntries(s.server.id, [{ ...CHICAGO, effectiveFrom: null }]);
    await runServerLocationSyncWalk({ scope: 'behind' });
    await setEntries(s.server.id, []);
    expect(await getServerLocations(s.server.id)).toEqual({ entries: [], syncPending: true });

    await runServerLocationSyncWalk({ scope: 'behind' });

    for (const id of [s.oldLocal.id, s.oldFormat.id, s.recentLocal.id]) {
      expect(await geoOf(id)).toEqual({
        is_local: true,
        geo_city: null,
        geo_region: null,
        geo_country: 'Local Network',
        geo_continent: null,
        geo_postal: null,
        geo_lat: null,
        geo_lon: null,
      });
    }
  });

  it('stamps a server that never had a location without rewriting its rows until a full run', async () => {
    const s = await seed();
    const ids = [s.oldLocal.id, s.oldFormat.id, s.recentLocal.id, s.labelledPublic.id];
    const before = [];
    for (const id of ids) before.push(await geoOf(id));

    await runServerLocationSyncWalk({ scope: 'behind' });

    expect((await getServerLocations(s.server.id))?.syncPending).toBe(false);
    for (const [index, id] of ids.entries()) {
      const row = await geoOf(id);
      expect(row).toEqual(before[index]);
      expect(row.is_local).toBeNull();
    }
    expect((await geoOf(s.oldLocal.id)).geo_country).toBe('Local Network');
    expect((await geoOf(s.oldFormat.id)).geo_city).toBe('Local');
    // Back to never synced: what a manual run meets before the first automatic one has run.
    await db.update(servers).set({ locationSyncedVersion: 0 }).where(eq(servers.id, s.server.id));

    await runServerLocationSyncWalk({ scope: 'all' });

    for (const id of [s.oldLocal.id, s.oldFormat.id, s.recentLocal.id]) {
      expect(await geoOf(id)).toMatchObject({
        is_local: true,
        geo_city: null,
        geo_country: 'Local Network',
      });
    }
    expect(await geoOf(s.labelledPublic.id)).toMatchObject({ is_local: false });
  });

  it('counts unclassified remote rows as remote', async () => {
    const s = await seed();

    const result = await db.execute(sql`
      SELECT count(*)::int AS n FROM sessions s
      WHERE s.server_id = ${s.server.id}::uuid AND NOT ${localSessionSql('s')}
    `);

    expect((result.rows[0] as { n: number }).n).toBe(1);
  });

  it('leaves a server behind when its entries change during the run', async () => {
    const s = await seed();
    await setEntries(s.server.id, [{ ...CHICAGO, effectiveFrom: null }]);
    let bumped = false;

    await runServerLocationSyncWalk({
      scope: 'behind',
      batchSize: 1,
      onBatch: async () => {
        if (!bumped) {
          bumped = true;
          await bumpVersion(s.server.id);
        }
      },
    });

    const [row] = await db
      .select({ v: servers.locationVersion, s: servers.locationSyncedVersion })
      .from(servers)
      .where(eq(servers.id, s.server.id));
    expect(row && row.v !== row.s).toBe(true);
  });
});

describe('server location sync over a compressed chunk', { timeout: 120_000 }, () => {
  /** Uncompressed heap rows across the compressed-age sessions chunks, and whether each is compressed */
  async function oldChunkHeaps() {
    const { rows } = await db.execute(sql`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS name, is_compressed
      FROM timescaledb_information.chunks
      WHERE hypertable_name = 'sessions' AND range_end <= now() - interval '30 days'
    `);
    const chunks = rows as Array<{ name: string; is_compressed: boolean }>;
    let heap = 0;
    for (const chunk of chunks) {
      const result = await db.execute(
        sql`SELECT count(*)::int AS n FROM ONLY ${sql.raw(chunk.name)}`
      );
      heap += (result.rows[0] as { n: number }).n;
    }
    return { chunks: chunks.length, compressed: chunks.every((c) => c.is_compressed), heap };
  }

  /**
   * FILLER_SESSIONS local plays of one account already placed in Chicago, one a minute, and
   * `changed` local plays in the Local Network shape between them: each in its own account's
   * batch when `lone`, otherwise all in one. The database's decompression cap is 10 while the
   * walk runs, so a write that kept the cap fails.
   */
  async function syncThroughCompressedChunk(changed: number, lone: boolean) {
    const server = await createTestServer();
    const newAccount = async () =>
      createTestServerUser({ serverId: server.id, userId: (await createTestUser()).id });
    const base = new Date(Math.floor((Date.now() - 60 * DAY) / DAY) * DAY + DAY / 4);
    const filler = await newAccount();
    for (let i = 0; i < FILLER_SESSIONS; i++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: filler.id,
        ipAddress: '192.168.1.20',
        startedAt: new Date(base.getTime() + i * MIN),
      });
    }
    const shared = await newAccount();
    for (let i = 0; i < changed; i++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: lone ? (await newAccount()).id : shared.id,
        ipAddress: '192.168.1.21',
        startedAt: new Date(
          base.getTime() + MIN / 2 + Math.floor((i * (FILLER_SESSIONS - 1)) / changed) * MIN + i
        ),
      });
    }
    await db.execute(sql`
      UPDATE sessions SET is_local = true, geo_city = ${CHICAGO.city}, geo_region = ${CHICAGO.region},
        geo_country = ${CHICAGO.country}, geo_lat = ${CHICAGO.lat}::real, geo_lon = ${CHICAGO.lon}::real,
        geo_continent = NULL, geo_postal = NULL
      WHERE server_user_id = ${filler.id}::uuid
    `);
    await db.execute(sql`
      UPDATE sessions SET is_local = NULL, geo_city = NULL, geo_region = NULL, geo_country = 'Local Network',
        geo_lat = NULL, geo_lon = NULL, geo_continent = NULL, geo_postal = NULL
      WHERE server_id = ${server.id}::uuid AND server_user_id <> ${filler.id}::uuid
    `);
    await setEntries(server.id, [{ ...CHICAGO, effectiveFrom: null }]);
    expect((await compressSessionChunks(30)).length).toBeGreaterThanOrEqual(1);
    expect(await oldChunkHeaps()).toMatchObject({ compressed: true, heap: 0 });

    const dbName = (
      (await db.execute(sql`SELECT current_database() AS db`)).rows[0] as { db: string }
    ).db;
    await db.execute(
      sql.raw(
        `ALTER DATABASE "${dbName}" SET timescaledb.max_tuples_decompressed_per_dml_transaction = 10`
      )
    );
    await recreatePool();
    try {
      const { total } = await runServerLocationSyncWalk({ scope: 'behind' });
      const placed = await db.execute(sql`
        SELECT count(*)::int AS n FROM sessions
        WHERE server_id = ${server.id}::uuid AND is_local AND geo_city = ${CHICAGO.city}
      `);
      expect((placed.rows[0] as { n: number }).n).toBe(FILLER_SESSIONS + changed);
      return { total, after: await oldChunkHeaps() };
    } finally {
      await db.execute(
        sql.raw(
          `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
        )
      );
      await recreatePool();
    }
  }

  it('leaves a compressed chunk compressed and untouched when every row is placed', async () => {
    const { total, after } = await syncThroughCompressedChunk(0, true);
    expect(total).toBe(0);
    expect(after).toMatchObject({ compressed: true, heap: 0 });
  });

  it('decompresses only the batches of the rows it places', async () => {
    const { total, after } = await syncThroughCompressedChunk(3, true);
    expect(total).toBe(3);
    expect(after.heap).toBe(3);
  });

  it('places up to the point-update limit by point updates, decompressing only their batch', async () => {
    // Below the crossover measured on TimescaleDB 2.28 and 2.31; re-measure before moving it.
    expect(MAX_POINT_UPDATES_PER_PASS).toBe(50);
    const { total, after } = await syncThroughCompressedChunk(MAX_POINT_UPDATES_PER_PASS, false);
    expect(total).toBe(MAX_POINT_UPDATES_PER_PASS);
    expect(after.heap).toBe(MAX_POINT_UPDATES_PER_PASS);
  });

  it('places more rows than the point-update limit with the batch statement, decompressing its span', async () => {
    const { total, after } = await syncThroughCompressedChunk(
      MAX_POINT_UPDATES_PER_PASS + 1,
      false
    );
    expect(total).toBe(MAX_POINT_UPDATES_PER_PASS + 1);
    expect(after.heap).toBe(MAX_POINT_UPDATES_PER_PASS + 1 + FILLER_SESSIONS);
  });
});
