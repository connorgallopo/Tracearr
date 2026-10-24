/**
 * Readers of the local flag against real TimescaleDB. The stream map, user locations and
 * device locations keep a placed local point apart from remote plays at the same coordinates,
 * and the history network filter classifies rows the location sync has not reached (flag
 * NULL) by their label.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- serverLocationReaders
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { locationsRoutes } from '../../src/routes/stats/locations.js';
import { queryUserDevices, queryUserLocations } from '../../src/routes/users/queries/index.js';
import { permissionGuard } from '../../src/lib/scope.js';

const CHICAGO = {
  geoCity: 'Chicago',
  geoRegion: 'Illinois',
  geoCountry: 'US',
  geoLat: 41.8781,
  geoLon: -87.6298,
};
const PARIS = {
  geoCity: 'Paris',
  geoRegion: 'Ile-de-France',
  geoCountry: 'FR',
  geoLat: 48.8566,
  geoLon: 2.3522,
};

async function buildApp(plugin: Parameters<typeof Fastify.prototype.register>[0]) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate('authenticate', async (request: any) => {
    request.user = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (request.user.role !== 'owner') return reply.forbidden('Owner access required');
  });
  await app.register(plugin as any);
  return app;
}

/**
 * One device, five plays: two classified remote and one placed local, all at Chicago's
 * coordinates, plus two the sync has not classified yet: a Local Network row and a Paris row.
 */
async function seed() {
  const server = await createTestServer({ type: 'plex' });
  const user = await createTestUser({ role: 'member' });
  const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });
  const play = (ipAddress: string, geo: typeof CHICAGO) =>
    createTestSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      deviceId: 'living-room',
      ipAddress,
      ...geo,
    });

  const remoteA = await play('8.8.8.8', CHICAGO);
  const remoteB = await play('8.8.4.4', CHICAGO);
  const placed = await play('192.168.1.20', CHICAGO);
  const unclassifiedLocal = await play('192.168.1.21', CHICAGO);
  const unclassifiedRemote = await play('1.1.1.1', PARIS);

  await db.execute(sql`
    UPDATE sessions SET is_local = false WHERE id IN (${remoteA.id}::uuid, ${remoteB.id}::uuid)
  `);
  await db.execute(sql`UPDATE sessions SET is_local = true WHERE id = ${placed.id}::uuid`);
  await db.execute(sql`
    UPDATE sessions SET geo_city = NULL, geo_region = NULL, geo_country = 'Local Network',
      geo_lat = NULL, geo_lon = NULL
    WHERE id = ${unclassifiedLocal.id}::uuid
  `);

  return { server, serverUser, remoteA, remoteB, placed, unclassifiedLocal, unclassifiedRemote };
}

describe('local flag readers', () => {
  it('keeps a placed local point apart from remote plays at the same coordinates on the stream map', async () => {
    const { server, serverUser } = await seed();

    const app = await buildApp(locationsRoutes);
    const response = await app.inject({
      method: 'GET',
      url: `/locations?period=all&serverUserId=${serverUser.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const rows = response.json().data as {
      city: string;
      isLocal: boolean;
      count: number;
      servers: { serverId: string; count: number }[];
    }[];
    expect(rows.map((r) => `${r.city}|${r.isLocal}|${r.count}`).sort()).toEqual([
      'Chicago|false|2',
      'Chicago|true|1',
      'Paris|false|1',
      'null|true|1',
    ]);
    for (const row of rows) {
      expect(row.servers).toEqual([{ serverId: server.id, count: row.count }]);
    }
  });

  it('splits user locations and device locations by the flag', async () => {
    const { serverUser } = await seed();
    const expected = [
      'Chicago|US|false|2',
      'Chicago|US|true|1',
      'Paris|FR|false|1',
      'null|Local Network|true|1',
    ];

    const locations = await queryUserLocations(db, [serverUser.id]);
    expect(
      locations.map((l) => `${l.city}|${l.country}|${l.isLocal}|${l.sessionCount}`).sort()
    ).toEqual(expected);

    const devices = await queryUserDevices(db, [serverUser.id]);
    expect(devices).toHaveLength(1);
    expect(
      devices[0]?.locations
        .map((l) => `${l.city}|${l.country}|${l.isLocal}|${l.sessionCount}`)
        .sort()
    ).toEqual(expected);
  });

  it('classifies unsynced rows by their label in the history network filter', async () => {
    const s = await seed();

    const app = await buildApp(sessionRoutes);
    const history = async (network: 'local' | 'remote') => {
      const response = await app.inject({
        method: 'GET',
        url: `/history?network=${network}&serverUserIds=${s.serverUser.id}`,
      });
      expect(response.statusCode).toBe(200);
      return response.json().data as { id: string; isLocal: boolean }[];
    };
    const local = await history('local');
    const remote = await history('remote');
    await app.close();

    expect(local.map((r) => r.id).sort()).toEqual([s.placed.id, s.unclassifiedLocal.id].sort());
    expect(local.every((r) => r.isLocal)).toBe(true);
    expect(remote.map((r) => r.id).sort()).toEqual(
      [s.remoteA.id, s.remoteB.id, s.unclassifiedRemote.id].sort()
    );
    expect(remote.every((r) => !r.isLocal)).toBe(true);
  });
});
