/**
 * tofa request sync against the real database, replaying the request list as it was recorded
 * on a tofa server at each step: a show requested and waiting, approved, a movie requested
 * beside it, the movie deleted, then the show deleted. tofa keeps no trace of a deleted
 * request, so each deletion reaches the mirror only as a request missing from the list.
 *
 * Run with: pnpm --filter @tracearr/server test:integration tofaRequestsSync
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestServerUser,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import {
  addBuiltInRequestServices,
  anyRequestServiceLinked,
  followServerOnBuiltInRequestService,
} from '../../src/services/requests/store.js';
import { runRequestSync } from '../../src/services/requests/sync.js';
import { fakeTofaRequestSource } from '../../src/test/mediaServerFakes.js';
import tofa from '../../src/test/mediaServerResponses/tofa.json' with { type: 'json' };

const REQUESTER = 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14';
const SHOW = '5a1d0000-4c2e-4f6a-9b3d-000000000001';
const MOVIE = '5a1d0000-4c2e-4f6a-9b3d-000000000002';

async function seed(): Promise<{ serverId: string; serviceId: string; requesterId: string }> {
  const server = await createTestServer({ type: 'tofa' });
  const user = await createTestUser({ role: 'member' });
  const requester = await createTestServerUser({
    userId: user.id,
    serverId: server.id,
    externalId: REQUESTER,
  });
  const [serviceId] = await addBuiltInRequestServices(db, ['tofa']);
  if (!serviceId) throw new Error('no request service was created for the tofa server');
  return { serverId: server.id, serviceId, requesterId: requester.id };
}

async function mirror(serviceId: string): Promise<Record<string, unknown>[]> {
  const result = await db.execute(sql`
    SELECT remote_id, remote_media_id, title, media_type, status, seasons, server_user_id, deleted_at
    FROM media_requests WHERE service_id = ${serviceId}
  `);
  return result.rows as unknown as Record<string, unknown>[];
}

describe('tofa request sync', () => {
  it('gives each tofa server one built-in request service, created once, that follows its name and address', async () => {
    const { serverId, serviceId } = await seed();
    const builtIn = () =>
      db.execute(sql`
        SELECT id, type, name, url, config, remote_server_id
        FROM request_services WHERE server_id = ${serverId}
      `);

    expect(await addBuiltInRequestServices(db, ['tofa'])).toEqual([]);
    const server = await db.execute(sql`SELECT name, url FROM servers WHERE id = ${serverId}`);
    expect((await builtIn()).rows).toEqual([
      { id: serviceId, type: 'tofa', ...server.rows[0], config: null, remote_server_id: null },
    ]);

    await db.execute(
      sql`UPDATE servers SET name = 'Den', url = 'http://tofa.den:33333' WHERE id = ${serverId}`
    );
    await followServerOnBuiltInRequestService(db, serverId);
    expect((await builtIn()).rows[0]).toMatchObject({ name: 'Den', url: 'http://tofa.den:33333' });
  });

  it('follows the recorded list through a request, its approval and both deletions', async () => {
    const { serviceId, requesterId } = await seed();
    const [waiting, approved, both, showOnly, empty] = tofa.requestListStates;
    if (!waiting || !approved || !both || !showOnly || !empty) {
      throw new Error('the fixture holds five recorded list states');
    }
    const replay = (requests: typeof waiting) =>
      runRequestSync(serviceId, 'incremental', {
        tofaClientFor: () => fakeTofaRequestSource({ getRequests: async () => requests }),
      });

    await replay(waiting);
    expect(await mirror(serviceId)).toEqual([
      {
        remote_id: SHOW,
        remote_media_id: null,
        title: 'Copper Coast',
        media_type: 'show',
        status: 'pending',
        seasons: [{ seasonNumber: 2, status: 'pending' }],
        server_user_id: requesterId,
        deleted_at: null,
      },
    ]);

    await replay(approved);
    expect(await mirror(serviceId)).toMatchObject([
      { remote_id: SHOW, status: 'approved', seasons: [{ seasonNumber: 2, status: 'approved' }] },
    ]);

    await replay(both);
    expect(await mirror(serviceId)).toHaveLength(2);

    const movieGone = await replay(showOnly);
    expect(movieGone.markedDeleted).toBe(1);
    const rows = await mirror(serviceId);
    expect(rows.find((r) => r.remote_id === MOVIE)?.deleted_at).not.toBeNull();
    expect(rows.find((r) => r.remote_id === SHOW)?.deleted_at).toBeNull();

    await replay(empty);
    expect((await mirror(serviceId)).every((r) => r.deleted_at !== null)).toBe(true);
  });

  it('offers Requests for a tofa server only while tofa has its requests on', async () => {
    const { serviceId } = await seed();
    const syncWith = (requestsAvailable: boolean) =>
      runRequestSync(serviceId, 'full', {
        tofaClientFor: () =>
          fakeTofaRequestSource({
            systemInfo: async () => ({ ...tofa.systemInfo, requests_available: requestsAvailable }),
          }),
      });

    await syncWith(false);
    expect(await anyRequestServiceLinked()).toBe(false);

    await syncWith(true);
    expect(await anyRequestServiceLinked()).toBe(true);
  });

  it('removes the request service and its mirror with the server', async () => {
    const { serverId, serviceId } = await seed();
    await runRequestSync(serviceId, 'full', { tofaClientFor: () => fakeTofaRequestSource() });
    expect(await mirror(serviceId)).toHaveLength(tofa.requests.length);

    await db.execute(sql`DELETE FROM servers WHERE id = ${serverId}`);

    const services = await db.execute(sql`SELECT id FROM request_services WHERE id = ${serviceId}`);
    expect(services.rows).toEqual([]);
    expect(await mirror(serviceId)).toEqual([]);
  });
});
