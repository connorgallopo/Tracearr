/**
 * GET /stats/locations agrees with History
 *
 * A location is (city, region, country, local flag). Its count is History's play count for
 * the same filters, so the Map page can link each location to History and show one number.
 *
 * Run with: pnpm --filter @tracearr/server test:integration mapLocations
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
import type { LocationStats, LocationStatsSummary } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { locationsRoutes } from '../../src/routes/stats/locations.js';
import { mergeUsers } from '../../src/services/mergeService.js';
import { permissionGuard } from '../../src/lib/scope.js';

const OGDEN = { geoCity: 'Ogden', geoRegion: 'Utah', geoCountry: 'US' };
const PARIS = {
  geoCity: 'Paris',
  geoRegion: 'Ile-de-France',
  geoCountry: 'FR',
  geoLat: 48.8566,
  geoLon: 2.3522,
};

function ownerAuth(userId: string) {
  return { userId, username: 'owner', role: 'owner' as const, serverIds: [] as string[] };
}

async function buildApp(plugin: Parameters<typeof Fastify.prototype.register>[0]) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate('authenticate', async (request: any) => {
    request.user = ownerAuth('owner');
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (request.user.role !== 'owner') return reply.forbidden('Owner access required');
  });
  await app.register(plugin as any);
  return app;
}

async function getLocations(query: string) {
  const app = await buildApp(locationsRoutes);
  const response = await app.inject({ method: 'GET', url: `/locations?${query}` });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.json() as { data: LocationStats[]; summary: LocationStatsSummary };
}

async function getPeople(query: string) {
  const app = await buildApp(locationsRoutes);
  const response = await app.inject({ method: 'GET', url: `/locations/people?${query}` });
  await app.close();
  expect(response.statusCode).toBe(200);
  return (response.json() as { data: LocationStats[] }).data;
}

async function historyPlayCount(params: URLSearchParams) {
  const app = await buildApp(sessionRoutes);
  const response = await app.inject({ method: 'GET', url: `/history/aggregates?${params}` });
  await app.close();
  expect(response.statusCode).toBe(200);
  return (response.json() as { playCount: number }).playCount;
}

async function seedAccount() {
  const server = await createTestServer({ type: 'plex' });
  const user = await createTestUser({ role: 'member' });
  const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });
  const play = (overrides: Partial<Parameters<typeof createTestSession>[0]> = {}) =>
    createTestSession({ serverId: server.id, serverUserId: serverUser.id, ...overrides });
  return { server, serverUser, play };
}

describe('GET /stats/locations', () => {
  it('groups one city with two coordinates into one location at the most-played coordinate', async () => {
    const { play } = await seedAccount();
    for (let i = 0; i < 3; i++) await play({ ...OGDEN, geoLat: 41.22, geoLon: -111.97 });
    await play({ ...OGDEN, geoLat: 41.23, geoLon: -111.95 });

    const { data } = await getLocations('period=all');

    expect(data).toHaveLength(1);
    const [row] = data;
    expect(row?.count).toBe(4);
    expect(row?.lat).toBeCloseTo(41.22, 4);
    expect(row?.lon).toBeCloseTo(-111.97, 4);
  });

  it('excludes trailers when no media type is chosen', async () => {
    const { play } = await seedAccount();
    await play({ mediaType: 'episode' });
    await play({ mediaType: 'episode' });
    const trailer = await play({ mediaType: 'movie' });
    await db.execute(
      sql`UPDATE sessions SET media_type = 'trailer' WHERE id = ${trailer.id}::uuid`
    );

    const { data, summary } = await getLocations('period=all');

    expect(data.map((r) => r.count)).toEqual([2]);
    expect(summary.totalStreams).toBe(2);
  });

  it('returns every location, not the first 500', async () => {
    const { play } = await seedAccount();
    await Promise.all(
      Array.from({ length: 501 }, (_, i) =>
        play({ geoCity: `City ${i}`, geoRegion: 'Region', geoCountry: 'US' })
      )
    );

    const { data, summary } = await getLocations('period=all');

    expect(data).toHaveLength(501);
    expect(summary.uniqueLocations).toBe(501);
  });

  it('counts a play chain once in the total even when it spans two locations', async () => {
    const { play } = await seedAccount();
    const first = await play({ ...OGDEN, geoLat: 41.22, geoLon: -111.97 });
    await play({ ...PARIS, referenceId: first.id });

    const { data, summary } = await getLocations('period=all');

    expect(data.map((r) => r.count)).toEqual([1, 1]);
    expect(summary.totalStreams).toBe(1);
  });

  it('lists every person with their count, merged identities as one entry', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const account = async (name: string, serverId: string) => {
      const user = await createTestUser({ role: 'member', name });
      const serverUser = await createTestServerUser({ userId: user.id, serverId });
      return { user, serverUser };
    };
    const a = await account('Person A', serverA.id);
    const b = await account('Person B', serverA.id);
    const target = await account('Merged Person', serverA.id);
    const source = await account('Merged Source', serverB.id);

    for (let i = 0; i < 3; i++) {
      await createTestSession({ serverId: serverA.id, serverUserId: a.serverUser.id });
    }
    await createTestSession({ serverId: serverA.id, serverUserId: b.serverUser.id });
    await createTestSession({ serverId: serverA.id, serverUserId: target.serverUser.id });
    await createTestSession({ serverId: serverB.id, serverUserId: source.serverUser.id });
    await mergeUsers(source.user.id, target.user.id, admin.id);

    const { data } = await getLocations('period=all');

    expect(data).toHaveLength(1);
    const [row] = data;
    expect(row?.peopleCount).toBe(3);
    expect(row?.users?.map((u) => [u.identityName, u.count])).toEqual([
      ['Person A', 3],
      ['Merged Person', 2],
      ['Person B', 1],
    ]);
    const serverOf = new Map([
      [a.serverUser.id, serverA.id],
      [b.serverUser.id, serverA.id],
      [target.serverUser.id, serverA.id],
      [source.serverUser.id, serverB.id],
    ]);
    for (const person of row?.users ?? []) {
      expect(person.serverId).toBe(serverOf.get(person.id));
    }
    const merged = row?.users?.find((u) => u.identityName === 'Merged Person');
    expect(merged?.serverUserIds.slice().sort()).toEqual(
      [target.serverUser.id, source.serverUser.id].sort()
    );

    const filtered = await getLocations(
      `period=all&serverUserIds=${target.serverUser.id},${source.serverUser.id}`
    );

    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0]?.peopleCount).toBe(1);
    expect(filtered.data[0]?.users?.map((u) => [u.identityName, u.count])).toEqual([
      ['Merged Person', 2],
    ]);
  });

  it('counts sessions without coordinates toward their named place', async () => {
    const { play } = await seedAccount();
    await play({ geoCity: 'Boise', geoRegion: 'Idaho', geoCountry: 'US' });
    const unplaced = await play({ geoCity: 'Boise', geoRegion: 'Idaho', geoCountry: 'US' });
    const nampa = await play({ geoCity: 'Nampa', geoRegion: 'Idaho', geoCountry: 'US' });
    await db.execute(sql`
      UPDATE sessions SET geo_lat = NULL, geo_lon = NULL
      WHERE id IN (${unplaced.id}::uuid, ${nampa.id}::uuid)
    `);

    const { data } = await getLocations('period=all');

    const boise = data.find((r) => r.city === 'Boise');
    expect(data.filter((r) => r.city === 'Boise')).toHaveLength(1);
    expect(boise?.count).toBe(2);
    expect(boise?.lat).not.toBeNull();
    const nampaRow = data.find((r) => r.city === 'Nampa');
    expect(nampaRow).toMatchObject({ count: 1, lat: null, lon: null });
  });

  it("matches History for every location's link", async () => {
    const { play } = await seedAccount();
    await play({ ...OGDEN, geoLat: 41.22, geoLon: -111.97 });
    await play({ ...OGDEN, geoLat: 41.23, geoLon: -111.95 });
    const local = await play({ ...OGDEN, geoLat: 41.22, geoLon: -111.97 });
    await play(PARIS);
    const trailer = await play(PARIS);
    const countryOnly = await play({ geoCountry: 'DE' });
    await db.execute(sql`UPDATE sessions SET is_local = true WHERE id = ${local.id}::uuid`);
    await db.execute(
      sql`UPDATE sessions SET media_type = 'trailer' WHERE id = ${trailer.id}::uuid`
    );
    await db.execute(sql`
      UPDATE sessions SET geo_city = NULL, geo_region = NULL WHERE id = ${countryOnly.id}::uuid
    `);

    const { data } = await getLocations('period=all');

    expect(data).toHaveLength(4);
    for (const row of data) {
      const params = new URLSearchParams({
        geoCountries: row.country ?? '',
        network: row.isLocal ? 'local' : 'remote',
      });
      if (row.city) params.set('geoCity', row.city);
      else params.set('geoCityMissing', 'true');
      if (row.region) params.set('geoRegion', row.region);
      else params.set('geoRegionMissing', 'true');

      expect(await historyPlayCount(params), JSON.stringify(row)).toBe(row.count);
    }
  });

  it('ends a custom range just before endDate like History, whatever zone the server is in', async () => {
    const { play } = await seedAccount();
    // June 10 for a browser at UTC+10: the server must not stretch the end to its own midnight.
    const startDate = new Date('2026-06-09T14:00:00.000Z');
    const endDate = new Date('2026-06-10T14:00:00.000Z');
    await play({ startedAt: new Date('2026-06-10T13:59:00.000Z') });
    await play({ startedAt: endDate });
    const range = `startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`;

    const { data } = await getLocations(`period=custom&${range}`);

    expect(data.map((r) => r.count)).toEqual([1]);
    expect(await historyPlayCount(new URLSearchParams(range))).toBe(1);
  });

  it('carries the first three people in the list and every person from /locations/people', async () => {
    const server = await createTestServer({ type: 'plex' });
    for (const [name, plays] of [
      ['Dee', 1],
      ['Ann', 4],
      ['Cal', 2],
      ['Bea', 3],
    ] as const) {
      const user = await createTestUser({ role: 'member', name });
      const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });
      for (let i = 0; i < plays; i++) {
        await createTestSession({ serverId: server.id, serverUserId: serverUser.id, ...OGDEN });
      }
    }
    await createTestSession({
      serverId: server.id,
      serverUserId: (await seedAccount()).serverUser.id,
      ...PARIS,
    });

    const { data } = await getLocations('period=all');
    const ogden = data.find((r) => r.city === 'Ogden');
    expect(ogden?.peopleCount).toBe(4);
    expect(ogden?.users?.map((u) => u.identityName)).toEqual(['Ann', 'Bea', 'Cal']);

    const every = ['Ann', 'Bea', 'Cal', 'Dee'];
    const key = JSON.stringify([ogden?.country, ogden?.region, ogden?.city, ogden?.isLocal]);
    const byPlace = await getPeople(`period=all&place=${encodeURIComponent(key)}`);
    expect(byPlace.map((r) => r.city)).toEqual(['Ogden']);
    expect(byPlace[0]?.users?.map((u) => u.identityName)).toEqual(every);

    const box = `west=${ogden?.lon}&south=${ogden?.lat}&east=${ogden?.lon}&north=${ogden?.lat}`;
    const byBox = await getPeople(`period=all&${box}`);
    expect(byBox.map((r) => r.city)).toEqual(['Ogden']);
    expect(byBox[0]?.users?.map((u) => u.identityName)).toEqual(every);

    const filtered = await getPeople(`period=all&mediaType=episode&${box}`);
    expect(filtered).toEqual([]);
  });
});
