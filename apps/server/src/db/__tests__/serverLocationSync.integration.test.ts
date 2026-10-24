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
import { db } from '../client.js';
import { servers } from '../schema.js';
import { runServerLocationSyncWalk } from '../../jobs/serverLocationSync.js';
import { getServerLocations, replaceServerLocations } from '../../services/serverLocations.js';
import { localSessionSql } from '../../db/sessions/rules.js';
import { compressSessionChunks } from '../../test/compressChunks.js';

const DAY = 24 * 60 * 60 * 1000;
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
